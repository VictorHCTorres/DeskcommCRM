import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClickUpManifest } from "@/lib/clickup/contrato";
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

export const CLICKUP_CONNECTION_SAFE_COLUMNS =
  "id, organization_id, workspace_id, workspace_name, token_last4, status, created_by, created_at, updated_at";
export const CLICKUP_RUN_SAFE_COLUMNS =
  "id, organization_id, connection_id, workspace_id, source, scope, status, dry_run, manifest_version, snapshot_hash, source_revision, preview_revision, mapping_revision, mapping_hash, attempt, max_attempts, checkpoint, total_items, applicable_items, warnings_count, conflicts_count, succeeded_items, failed_items, skipped_items, error_code, cancel_requested_at, started_at, finished_at, created_by, created_at, updated_at";
export const CLICKUP_ITEM_SAFE_COLUMNS =
  "id, organization_id, run_id, workspace_id, entity_type, external_id, parent_external_id, source_revision, source_hash, source_metadata, content_access, execution_blocked, blocked_reason, status, attempts, max_attempts, next_attempt_at, error_code, error_message, payload_purged_at, created_at, updated_at";

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
  input: { organizationId: string; runId: string; afterId?: string; limit: number },
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
  const { data: rows, error: itemsError } = await query;
  if (itemsError) throwDb(itemsError, "Não foi possível carregar os itens da importação.");
  const all = rows ?? [];
  const hasMore = all.length > input.limit;
  const items = hasMore ? all.slice(0, input.limit) : all;
  const last = items.at(-1);
  return {
    run,
    items,
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
    dryRun: true;
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
