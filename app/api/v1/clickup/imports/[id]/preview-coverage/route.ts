import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { clickupRunIdSchema } from "@/lib/clickup/contrato";
import { loadClickUpMemberDirectory } from "@/lib/clickup/crm/aplicar";
import { aggregateClickUpPreviewCoverage } from "@/lib/clickup/presentation/coverage";
import { createAdminClient } from "@/lib/supabase/admin";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "clickup_import_runs",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  const runId = clickupRunIdSchema.safeParse((await context.params).id);
  if (!runId.success) return fail("validation_failed", "Importação inválida.", 422, { requestId });

  const db = createAdminClient();
  const { data: run, error: runError } = await db
    .from("clickup_import_runs")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", runId.data)
    .maybeSingle();
  if (runError) return fail("internal_error", "Erro ao carregar a cobertura.", 500, { requestId });
  if (!run) return fail("not_found", "Importação não encontrada.", 404, { requestId });

  const metadata: unknown[] = [];
  for (let from = 0; ; from += 1_000) {
    const { data, error } = await db
      .from("clickup_import_items")
      .select("source_metadata")
      .eq("organization_id", authz.org.orgId)
      .eq("run_id", runId.data)
      .eq("entity_type", "task")
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) return fail("internal_error", "Erro ao carregar a cobertura.", 500, { requestId });
    metadata.push(...(data ?? []).map((item) => item.source_metadata));
    if ((data ?? []).length < 1_000) break;
  }
  const { data: workspace } = await db
    .from("clickup_import_items")
    .select("source_metadata")
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", runId.data)
    .eq("entity_type", "workspace")
    .maybeSingle();
  const workspaceMetadata =
    workspace?.source_metadata && typeof workspace.source_metadata === "object"
      ? (workspace.source_metadata as Record<string, unknown>)
      : {};
  const { count: relationRecords, error: relationError } = await db
    .from("clickup_import_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", runId.data)
    .eq("entity_type", "task_relation");
  if (relationError) {
    return fail("internal_error", "Erro ao carregar a cobertura.", 500, { requestId });
  }
  const directory = await loadClickUpMemberDirectory(db, authz.org.orgId);
  const coverage = aggregateClickUpPreviewCoverage({
    taskMetadata: metadata,
    archiveScope: workspaceMetadata.archive_scope,
    relationRecords: relationRecords ?? 0,
    isResolvedAssigneeEmail: (email) => directory.has(email),
  });
  return ok(coverage, {
    requestId,
    headers: { "Cache-Control": "private, no-store" },
  });
}
