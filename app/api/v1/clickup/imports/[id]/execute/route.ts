import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { clickupExecuteSchema, clickupRunIdSchema } from "@/lib/clickup/contrato";
import {
  aggregateClickUpPreviewCoverage,
  clickUpCoverageBlocksExecution,
} from "@/lib/clickup/presentation/coverage";
import { queueClickUpRun } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../../../_shared";

interface RouteContext {
  params: Promise<{ id: string }>;
}

async function loadServerCoverage(
  db: ReturnType<typeof createAdminClient>,
  organizationId: string,
  runId: string,
) {
  const taskMetadata: unknown[] = [];
  for (let from = 0; ; from += 1_000) {
    const { data, error } = await db
      .from("clickup_import_items")
      .select("source_metadata")
      .eq("organization_id", organizationId)
      .eq("run_id", runId)
      .eq("entity_type", "task")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error("clickup_coverage_unavailable");
    taskMetadata.push(...(data ?? []).map((item) => item.source_metadata));
    if ((data ?? []).length < 1_000) break;
  }
  const [{ data: workspace, error: workspaceError }, { count, error: relationError }] =
    await Promise.all([
      db
        .from("clickup_import_items")
        .select("source_metadata")
        .eq("organization_id", organizationId)
        .eq("run_id", runId)
        .eq("entity_type", "workspace")
        .maybeSingle(),
      db
        .from("clickup_import_items")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId)
        .eq("run_id", runId)
        .eq("entity_type", "task_relation"),
    ]);
  if (workspaceError || relationError) throw new Error("clickup_coverage_unavailable");
  const workspaceMetadata =
    workspace?.source_metadata && typeof workspace.source_metadata === "object"
      ? (workspace.source_metadata as Record<string, unknown>)
      : {};
  return aggregateClickUpPreviewCoverage({
    taskMetadata,
    archiveScope: workspaceMetadata.archive_scope,
    relationRecords: count ?? 0,
  });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "clickup_import_runs",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const idempotencyKey = chaveDaRequisicao(request);
  if (!idempotencyKey || !clickupRunIdSchema.safeParse(idempotencyKey).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID.", 400, { requestId });
  }
  const runId = clickupRunIdSchema.safeParse((await context.params).id);
  const body = clickupExecuteSchema.safeParse(await readJson(request));
  if (!runId.success || !body.success) {
    return fail("validation_failed", "Execução do ClickUp inválida.", 422, { requestId });
  }
  try {
    const db = createAdminClient();
    const serverCoverage = await loadServerCoverage(db, authz.org.orgId, runId.data);
    if (clickUpCoverageBlocksExecution(serverCoverage)) {
      return fail(
        "validation_failed",
        "A cobertura da importação está parcial ou contém campos ainda não suportados.",
        422,
        {
          requestId,
          details: {
            archive_scope: serverCoverage.archive_scope,
            blockers: serverCoverage.warnings
              .filter((warning) => warning.blocking)
              .map((warning) => warning.code),
          },
        },
      );
    }
    const outcome = await comIdempotencia({
      db,
      organizationId: authz.org.orgId,
      endpoint: `clickup.imports.${runId.data}.execute`,
      chave: idempotencyKey,
      corpo: body.data,
      executar: async () => ({
        resposta: await queueClickUpRun(db, {
          organizationId: authz.org.orgId,
          runId: runId.data,
          dryRun: body.data.dry_run,
          expectedPreviewRevision: body.data.expected_preview_revision,
          expectedSnapshotHash: body.data.expected_snapshot_hash,
          expectedMappingHash: body.data.expected_mapping_hash,
        }),
        status: 201,
      }),
    });
    if (outcome.tipo === "conflito") {
      return fail("idempotency_conflict", "A chave já foi usada com outro pedido.", 409, {
        requestId,
      });
    }
    if (outcome.tipo === "em_curso") {
      return fail("idempotency_in_progress", "Este pedido ainda está em processamento.", 409, {
        requestId,
      });
    }
    const data = outcome.resposta;
    if (outcome.tipo === "executou") {
      const importRunId = runId.data;
      void audit({
        action: "clickup.import_queued",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "clickup_import_run",
        resourceId: importRunId,
        requestId,
        bypassedRls: true,
        metadata: {
          dry_run: body.data.dry_run,
          preview_revision: body.data.expected_preview_revision,
        },
      });
    }
    return ok(data, {
      status: 201,
      requestId,
      headers: outcome.tipo === "replay" ? { "Idempotency-Replayed": "true" } : undefined,
    });
  } catch (error) {
    return clickupFailure(error, requestId);
  }
}
