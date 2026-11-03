import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClickUpManifest } from "@/lib/clickup/contrato";
import type { ClickUpSidecar } from "@/lib/clickup/sidecar-contrato";
import {
  clickupCrmMappingConfigSchema,
  validateEveryListIsMapped,
} from "@/lib/clickup/crm/contrato";
import { encryptClickUpToken } from "@/lib/clickup/crypto";
import { clickupHash, discoveredObjectToStaging, manifestHash } from "@/lib/clickup/manifest";

type Db = SupabaseClient;

export class ClickUpStoreError extends Error {
  constructor(
    readonly code: "not_found" | "conflict" | "invalid_state" | "database_error",
    message: string,
  ) {
    super(message);
  }
}

function throwDb(error: { code?: string; message: string } | null, fallback: string): never {
  if (error?.code === "23505") throw new ClickUpStoreError("conflict", fallback);
  if (error?.code === "40001") throw new ClickUpStoreError("conflict", fallback);
  if (error?.code === "P0002") throw new ClickUpStoreError("not_found", fallback);
  if (error?.code === "P0001") throw new ClickUpStoreError("invalid_state", fallback);
  throw new ClickUpStoreError("database_error", fallback);
}

/** Função SQL que retorna rowtype serializa `return null` como composite all-null no PostgREST. */
function claimedComposite(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const claimed = data as Record<string, unknown>;
  return claimed.id == null ? null : claimed;
}

export const CLICKUP_CONNECTION_SAFE_COLUMNS =
  "id, organization_id, workspace_id, workspace_name, token_last4, status, created_by, created_at, updated_at";
export const CLICKUP_RUN_SAFE_COLUMNS =
  "id, organization_id, connection_id, workspace_id, source, scope, status, dry_run, manifest_version, snapshot_hash, source_revision, preview_revision, mapping_revision, mapping_hash, attempt, max_attempts, checkpoint, total_items, applicable_items, warnings_count, conflicts_count, succeeded_items, failed_items, skipped_items, error_code, cancel_requested_at, started_at, finished_at, created_by, created_at, updated_at";
export const CLICKUP_ITEM_SAFE_COLUMNS =
  "id, organization_id, run_id, workspace_id, entity_type, external_id, parent_external_id, source_revision, source_hash, source_metadata, content_access, execution_blocked, blocked_reason, status, result_kind, attempts, max_attempts, next_attempt_at, error_code, error_message, payload_purged_at, created_at, updated_at";

async function loadRunSafe(db: Db, organizationId: string, runId: string) {
  const { data, error } = await db
    .from("clickup_import_runs")
    .select(CLICKUP_RUN_SAFE_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("id", runId)
    .maybeSingle();
  if (error) throwDb(error, "Não foi possível carregar a importação.");
  if (!data) throw new ClickUpStoreError("not_found", "Importação do ClickUp não encontrada.");
  return data;
}

export async function listClickUpConnections(db: Db, organizationId: string) {
  const { data, error } = await db
    .from("clickup_connections")
    .select(CLICKUP_CONNECTION_SAFE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("workspace_name");
  if (error) throwDb(error, "Não foi possível carregar as conexões do ClickUp.");
  return data ?? [];
}

export async function createClickUpConnection(
  db: Db,
  input: {
    organizationId: string;
    userId: string;
    workspaceId: string;
    workspaceName: string;
    token: string;
  },
) {
  const secret = encryptClickUpToken(input.token);
  const { data, error } = await db
    .from("clickup_connections")
    .insert({
      organization_id: input.organizationId,
      workspace_id: input.workspaceId,
      workspace_name: input.workspaceName,
      created_by: input.userId,
      ...secret,
    })
    .select(CLICKUP_CONNECTION_SAFE_COLUMNS)
    .single();
  if (error) throwDb(error, "Já existe uma conexão para este workspace.");
  return data;
}

export async function loadClickUpConnectionSecret(
  db: Db,
  organizationId: string,
  connectionId: string,
) {
  const { data, error } = await db
    .from("clickup_connections")
    .select(
      "id, organization_id, workspace_id, workspace_name, status, token_ciphertext, token_iv, token_tag",
    )
    .eq("organization_id", organizationId)
    .eq("id", connectionId)
    .eq("status", "active")
    .maybeSingle();
  if (error) throwDb(error, "Não foi possível carregar a conexão do ClickUp.");
  if (!data) throw new ClickUpStoreError("not_found", "Conexão do ClickUp não encontrada.");
  return data;
}

export async function getClickUpImportPage(
  db: Db,
  input: {
    organizationId: string;
    runId: string;
    afterId?: string;
    limit: number;
    entityTypes?: string[];
  },
) {
  const { data: run, error: runError } = await db
    .from("clickup_import_runs")
    .select(CLICKUP_RUN_SAFE_COLUMNS)
    .eq("organization_id", input.organizationId)
    .eq("id", input.runId)
    .maybeSingle();
  if (runError) throwDb(runError, "Não foi possível carregar a importação.");
  if (!run) throw new ClickUpStoreError("not_found", "Importação do ClickUp não encontrada.");

  let query = db
    .from("clickup_import_items")
    .select(CLICKUP_ITEM_SAFE_COLUMNS)
    .eq("organization_id", input.organizationId)
    .eq("run_id", input.runId)
    .order("id")
    .limit(input.limit + 1);
  if (input.afterId) query = query.gt("id", input.afterId);
  if (input.entityTypes?.length) query = query.in("entity_type", input.entityTypes);
  const { data: rows, error: itemsError } = await query;
  if (itemsError) throwDb(itemsError, "Não foi possível carregar os itens da importação.");
  const all = rows ?? [];
  const hasMore = all.length > input.limit;
  const items = hasMore ? all.slice(0, input.limit) : all;
  const last = items.at(-1);
  const tipos = ["list", "task", "custom_field"] as const;
  const contagens = await Promise.all(
    tipos.map(async (entityType) => {
      const { count, error } = await db
        .from("clickup_import_items")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", input.organizationId)
        .eq("run_id", input.runId)
        .eq("entity_type", entityType);
      if (error) throwDb(error, "Não foi possível resumir a prévia do ClickUp.");
      return [entityType, count ?? 0] as const;
    }),
  );
  return {
    run,
    items,
    summary: Object.fromEntries(contagens) as Record<(typeof tipos)[number], number>,
    cursor: hasMore && last ? String(last.id) : null,
    hasMore,
  };
}

export async function stageClickUpPreview(
  db: Db,
  input: { organizationId: string; userId: string; manifest: ClickUpManifest },
) {
  const hash = manifestHash(input.manifest);
  const { data: connection, error: connectionError } = await db
    .from("clickup_connections")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("id", input.manifest.connection_id)
    .eq("workspace_id", input.manifest.workspace_id)
    .eq("status", "active")
    .maybeSingle();
  if (connectionError) throwDb(connectionError, "Não foi possível validar a conexão do ClickUp.");
  if (!connection) throw new ClickUpStoreError("not_found", "Conexão do ClickUp não encontrada.");

  const now = new Date();
  const rows = input.manifest.objects.map((object) => discoveredObjectToStaging(object, now));
  const { data: runId, error } = await db.rpc("fn_stage_clickup_import_preview", {
    p_organization_id: input.organizationId,
    p_connection_id: input.manifest.connection_id,
    p_workspace_id: input.manifest.workspace_id,
    p_source: input.manifest.source,
    p_scope: input.manifest.scope,
    p_manifest_version: input.manifest.manifest_version,
    p_snapshot_hash: hash,
    p_source_revision: input.manifest.source_revision ?? null,
    p_created_by: input.userId,
    p_items: rows,
  });
  if (error || typeof runId !== "string") {
    throwDb(error, "Não foi possível montar a prévia do ClickUp.");
  }
  return loadRunSafe(db, input.organizationId, runId);
}

export async function updateClickUpMapping(
  db: Db,
  input: {
    organizationId: string;
    runId: string;
    expectedRevision: number;
    mapping: Record<string, unknown>;
  },
) {
  const { data: run, error: runError } = await db
    .from("clickup_import_runs")
    .select("scope")
    .eq("organization_id", input.organizationId)
    .eq("id", input.runId)
    .maybeSingle();
  if (runError) throwDb(runError, "Não foi possível validar a importação.");
  if (!run) throw new ClickUpStoreError("not_found", "Importação do ClickUp não encontrada.");
  if (run.scope === "crm" || run.scope === "all") {
    const crm = clickupCrmMappingConfigSchema.safeParse(input.mapping.crm);
    if (!crm.success) {
      throw new ClickUpStoreError("invalid_state", "O mapeamento CRM está incompleto.");
    }
    const { data: lists, error: listError } = await db
      .from("clickup_import_items")
      .select("external_id")
      .eq("organization_id", input.organizationId)
      .eq("run_id", input.runId)
      .eq("entity_type", "list");
    if (listError) throwDb(listError, "Não foi possível validar as Lists do ClickUp.");
    const coverage = validateEveryListIsMapped(
      (lists ?? []).map((list) => String(list.external_id)),
      crm.data,
    );
    if (!coverage.ok) {
      throw new ClickUpStoreError(
        "invalid_state",
        `Toda List exige destino explícito; faltam ${coverage.missing.length}.`,
      );
    }
    const { data: bindings, error: bindingError } = await db
      .from("clickup_import_items")
      .select("entity_type, external_id, parent_external_id, source_metadata")
      .eq("organization_id", input.organizationId)
      .eq("run_id", input.runId)
      .in("entity_type", ["status", "custom_field"]);
    if (bindingError) throwDb(bindingError, "Não foi possível validar status e campos.");
    for (const binding of bindings ?? []) {
      const metadata =
        binding.source_metadata && typeof binding.source_metadata === "object"
          ? (binding.source_metadata as Record<string, unknown>)
          : {};
      const listId = String(metadata.list_id ?? binding.parent_external_id ?? "");
      const sourceId = String(
        binding.entity_type === "status"
          ? (metadata.source_status_id ?? binding.external_id)
          : (metadata.source_field_id ?? binding.external_id),
      );
      const list = crm.data.lists.find((candidate) => candidate.list_id === listId);
      if (!list || list.mode === "ignore") continue;
      const decided =
        binding.entity_type === "status"
          ? list.statuses.some((status) => status.status_id === sourceId)
          : list.fields.some((field) => field.field_id === sourceId);
      if (!decided) {
        throw new ClickUpStoreError(
          "invalid_state",
          binding.entity_type === "status"
            ? "Todo status exige resultado explícito open/won/lost."
            : "Todo campo exige ação explícita native/text/ignore.",
        );
      }
    }
  }
  const { data, error } = await db.rpc("fn_update_clickup_import_mapping", {
    p_organization_id: input.organizationId,
    p_run_id: input.runId,
    p_expected_mapping_revision: input.expectedRevision,
    p_mapping: input.mapping,
    p_mapping_hash: clickupHash(input.mapping),
  });
  if (error) throwDb(error, "Não foi possível salvar o mapeamento.");
  if (!data) throw new ClickUpStoreError("conflict", "A prévia ou a revisão do mapeamento mudou.");
  return loadRunSafe(db, input.organizationId, input.runId);
}

export async function queueClickUpRun(
  db: Db,
  input: {
    organizationId: string;
    runId: string;
    dryRun: boolean;
    expectedPreviewRevision: number;
    expectedSnapshotHash: string;
    expectedMappingHash: string | null;
  },
) {
  const { data, error } = await db.rpc("fn_execute_clickup_import_run", {
    p_organization_id: input.organizationId,
    p_run_id: input.runId,
    p_preview_revision: input.expectedPreviewRevision,
    p_snapshot_hash: input.expectedSnapshotHash,
    p_mapping_hash: input.expectedMappingHash,
    p_dry_run: input.dryRun,
  });
  if (error) throwDb(error, "Não foi possível enfileirar a importação.");
  if (!data)
    throw new ClickUpStoreError("invalid_state", "A importação não está pronta para executar.");
  return loadRunSafe(db, input.organizationId, input.runId);
}

export async function retryClickUpRun(db: Db, organizationId: string, runId: string) {
  const { data, error } = await db.rpc("fn_retry_clickup_import_run", {
    p_organization_id: organizationId,
    p_run_id: runId,
  });
  if (error) throwDb(error, "Não foi possível tentar novamente.");
  if (!data)
    throw new ClickUpStoreError(
      "invalid_state",
      "A importação não pode ser repetida neste estado.",
    );
  return loadRunSafe(db, organizationId, runId);
}

export async function cancelClickUpRun(db: Db, organizationId: string, runId: string) {
  const { data, error } = await db.rpc("fn_cancel_clickup_import_run", {
    p_organization_id: organizationId,
    p_run_id: runId,
  });
  if (error) throwDb(error, "Não foi possível cancelar a importação.");
  if (!data)
    throw new ClickUpStoreError(
      "invalid_state",
      "A importação não pode ser cancelada neste estado.",
    );
  return loadRunSafe(db, organizationId, runId);
}

/** APIs internas do worker. Os composites contêm lease/payload e nunca devem
 * ser devolvidos por uma rota autenticada. */
export async function claimClickUpRunForProcessor(
  db: Db,
  workerId: string,
  processor: "crm" | "docs",
) {
  const { data, error } = await db.rpc("fn_claim_clickup_import_run_for_scope", {
    p_worker_id: workerId,
    p_processor: processor,
    p_lease_seconds: 90,
  });
  if (error) throwDb(error, "Não foi possível reivindicar a importação.");
  return claimedComposite(data);
}

export async function claimClickUpItemForProcessor(
  db: Db,
  organizationId: string,
  runId: string,
  processor: "crm" | "docs",
) {
  const { data, error } = await db.rpc("fn_claim_clickup_import_item_for_scope", {
    p_organization_id: organizationId,
    p_run_id: runId,
    p_processor: processor,
    p_lease_seconds: 90,
  });
  if (error) throwDb(error, "Não foi possível reivindicar o item da importação.");
  return claimedComposite(data);
}

export async function finishClickUpItem(
  db: Db,
  input: {
    organizationId: string;
    itemId: string;
    claimToken: string;
    outcome: "succeeded" | "skipped" | "failed" | "retry_wait";
    retryAt?: string;
    errorCode?: string;
    errorMessage?: string;
  },
) {
  const { data, error } = await db.rpc("fn_finish_clickup_import_item", {
    p_organization_id: input.organizationId,
    p_item_id: input.itemId,
    p_claim_token: input.claimToken,
    p_outcome: input.outcome,
    p_retry_at: input.retryAt ?? null,
    p_error_code: input.errorCode ?? null,
    p_error_message: input.errorMessage ?? null,
  });
  if (error) throwDb(error, "Não foi possível concluir o item da importação.");
  return data === true;
}

export async function heartbeatClickUpItem(db: Db, itemId: string, claimToken: string) {
  const { data, error } = await db.rpc("fn_heartbeat_clickup_import_item", {
    p_item_id: itemId,
    p_claim_token: claimToken,
    p_lease_seconds: 300,
  });
  if (error) throwDb(error, "Não foi possível renovar o lease do item.");
  return data === true;
}

export async function heartbeatClickUpProcessor(
  db: Db,
  input: {
    runId: string;
    processor: "crm" | "docs";
    workerId: string;
    leaseToken: string;
    checkpoint?: Record<string, unknown>;
  },
) {
  const { data, error } = await db.rpc("fn_heartbeat_clickup_import_processor", {
    p_run_id: input.runId,
    p_processor: input.processor,
    p_worker_id: input.workerId,
    p_lease_token: input.leaseToken,
    p_checkpoint: input.checkpoint ?? null,
    p_lease_seconds: 300,
  });
  if (error) throwDb(error, "Não foi possível renovar o lease do processador.");
  return data === true;
}

export async function markClickUpItemResult(
  db: Db,
  input: {
    organizationId: string;
    itemId: string;
    claimToken: string;
    resultKind: "created" | "updated" | "unchanged" | "skipped" | "conflict" | "validated";
  },
) {
  const { data, error } = await db.rpc("fn_mark_clickup_import_item_result", {
    p_organization_id: input.organizationId,
    p_item_id: input.itemId,
    p_claim_token: input.claimToken,
    p_result_kind: input.resultKind,
  });
  if (error) throwDb(error, "Não foi possível registrar o resultado do item.");
  return data === true;
}

export async function prepareClickUpAssetUpload(
  db: Db,
  input: {
    organizationId: string;
    userId: string;
    runId: string;
    kind: "sidecar" | "asset";
    attachmentId?: string;
    sha256: string;
    declaredSize: number;
  },
) {
  const { data: run, error: runError } = await db
    .from("clickup_import_runs")
    .select("id, workspace_id, snapshot_hash, status, cancel_requested_at")
    .eq("organization_id", input.organizationId)
    .eq("id", input.runId)
    .in("status", ["preview", "ready"])
    .is("cancel_requested_at", null)
    .maybeSingle();
  if (runError) throwDb(runError, "Não foi possível validar a importação.");
  if (!run) throw new ClickUpStoreError("not_found", "Importação do ClickUp não encontrada.");
  const uploadId = randomUUID();
  const path = `quarantine/${input.organizationId}/${input.runId}/${run.snapshot_hash}/${uploadId}/${input.sha256}`;
  const { data, error } = await db
    .from("clickup_asset_uploads")
    .insert({
      id: uploadId,
      organization_id: input.organizationId,
      run_id: input.runId,
      workspace_id: run.workspace_id,
      snapshot_hash: run.snapshot_hash,
      kind: input.kind,
      attachment_id: input.kind === "asset" ? input.attachmentId : null,
      sha256: input.sha256,
      declared_size: input.declaredSize,
      storage_path: path,
      state: "prepared",
      created_by: input.userId,
      expires_at: new Date(Date.now() + 24 * 60 * 60 * 1_000).toISOString(),
    })
    .select("id, storage_path, expires_at")
    .single();
  if (error || !data) throwDb(error, "Não foi possível preparar o upload privado.");
  return data;
}

export async function loadClickUpAssetUpload(
  db: Db,
  input: { organizationId: string; userId: string; runId: string; uploadId: string; kind?: string },
) {
  let query = db
    .from("clickup_asset_uploads")
    .select(
      "id, organization_id, run_id, workspace_id, snapshot_hash, kind, attachment_id, sha256, declared_size, storage_path, state, expires_at",
    )
    .eq("organization_id", input.organizationId)
    .eq("run_id", input.runId)
    .eq("id", input.uploadId)
    .eq("created_by", input.userId)
    .gt("expires_at", new Date().toISOString());
  if (input.kind) query = query.eq("kind", input.kind);
  const { data, error } = await query.maybeSingle();
  if (error) throwDb(error, "Não foi possível validar o upload privado.");
  if (!data) throw new ClickUpStoreError("not_found", "Upload privado não encontrado.");
  return data;
}

export async function stageClickUpAssetSidecar(
  db: Db,
  input: { organizationId: string; userId: string; runId: string; sidecar: ClickUpSidecar },
) {
  const { data, error } = await db.rpc("fn_stage_clickup_asset_sidecar", {
    p_organization_id: input.organizationId,
    p_run_id: input.runId,
    p_created_by: input.userId,
    p_sidecar: input.sidecar,
  });
  if (error || typeof data !== "string") {
    throwDb(error, "Não foi possível gravar o sidecar de anexos.");
  }
  return data;
}

export async function claimClickUpAsset(db: Db, workerId: string) {
  const { data, error } = await db.rpc("fn_claim_clickup_asset", {
    p_worker_id: workerId,
    p_lease_seconds: 300,
  });
  if (error) throwDb(error, "Não foi possível reivindicar o anexo ClickUp.");
  return claimedComposite(data);
}

export async function heartbeatClickUpAsset(
  db: Db,
  input: { organizationId: string; assetId: string; claimToken: string },
) {
  const { data, error } = await db.rpc("fn_heartbeat_clickup_asset", {
    p_organization_id: input.organizationId,
    p_asset_id: input.assetId,
    p_claim_token: input.claimToken,
    p_lease_seconds: 300,
  });
  if (error) throwDb(error, "Não foi possível renovar o lease do anexo.");
  return data === true;
}

export async function finishClickUpAsset(
  db: Db,
  input: {
    organizationId: string;
    assetId: string;
    claimToken: string;
    outcome:
      "promoted" | "unchanged" | "skipped" | "conflict" | "failed" | "retry_wait" | "cancelled";
    retryAt?: string;
    errorCode?: string;
    errorMessage?: string;
    finalStoragePath?: string;
  },
) {
  const { data, error } = await db.rpc("fn_finish_clickup_asset", {
    p_organization_id: input.organizationId,
    p_asset_id: input.assetId,
    p_claim_token: input.claimToken,
    p_outcome: input.outcome,
    p_retry_at: input.retryAt ?? null,
    p_error_code: input.errorCode ?? null,
    p_error_message: input.errorMessage ?? null,
    p_final_storage_path: input.finalStoragePath ?? null,
  });
  if (error) throwDb(error, "Não foi possível concluir o anexo ClickUp.");
  return data === true;
}
