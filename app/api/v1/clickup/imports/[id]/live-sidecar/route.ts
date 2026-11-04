import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { clickupRunIdSchema } from "@/lib/clickup/contrato";
import { startClickUpLiveSidecar } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

const bodySchema = z
  .object({
    mode: z.enum(["inventory", "full"]),
    include_private_docs: z.literal(true),
  })
  .strict();

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "clickup_import_runs" });
  if (!authz.ok) return authz.response;
  const runId = clickupRunIdSchema.safeParse((await context.params).id);
  const body = bodySchema.safeParse(await request.json().catch(() => null));
  if (!runId.success || !body.success)
    return fail("validation_failed", "Coleta ClickUp inválida.", 422, { requestId });
  if (
    (body.data.mode === "full" || body.data.include_private_docs) &&
    !roleAtLeast(authz.org.role, "admin")
  ) {
    return fail(
      "forbidden_role",
      "Somente administradores podem importar binários do ClickUp.",
      403,
      { requestId },
    );
  }
  try {
    const jobId = await startClickUpLiveSidecar(createAdminClient(), {
      organizationId: authz.org.orgId,
      runId: runId.data,
      mode: body.data.mode,
      includePrivateDocs: body.data.include_private_docs,
      userId: authz.user.id,
    });
    void audit({
      action: "clickup.live_sidecar_started",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "clickup_sidecar_collection_job",
      resourceId: jobId,
      requestId,
      bypassedRls: true,
      metadata: { mode: body.data.mode, include_private_docs: body.data.include_private_docs },
    });
    return ok({ job_id: jobId, status: "queued" }, { status: 201, requestId });
  } catch {
    return fail("state_conflict", "A coleta não pôde ser iniciada para esta prévia.", 409, {
      requestId,
    });
  }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "clickup_import_runs" });
  if (!authz.ok) return authz.response;
  const runId = clickupRunIdSchema.safeParse((await context.params).id);
  if (!runId.success) return fail("validation_failed", "Importação inválida.", 422, { requestId });
  const { data, error } = await createAdminClient()
    .from("clickup_sidecar_collection_jobs")
    .select(
      "id,run_id,mode,include_private_docs,status,tasks_expected,parents_completed,checkpoint,error_code,created_at,updated_at,finished_at",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", runId.data)
    .maybeSingle();
  if (error)
    return fail("internal_error", "Não foi possível consultar a coleta.", 500, { requestId });
  if (!data) return fail("not_found", "Coleta não encontrada.", 404, { requestId });
  const { count: remaining } = await createAdminClient()
    .from("clickup_sidecar_collection_parents")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", authz.org.orgId)
    .eq("job_id", data.id)
    .in("status", ["queued", "processing", "retry_wait"]);
  return ok(
    {
      ...data,
      parents_remaining: remaining ?? 0,
      estimated_minutes_remaining: Math.ceil((remaining ?? 0) / 20),
    },
    { requestId },
  );
}
