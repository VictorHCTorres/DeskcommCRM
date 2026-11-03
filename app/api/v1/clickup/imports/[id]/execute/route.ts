import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { clickupExecuteSchema, clickupRunIdSchema } from "@/lib/clickup/contrato";
import { queueClickUpRun } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../../../_shared";

interface RouteContext {
  params: Promise<{ id: string }>;
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
      void audit({
        action: "clickup.import_queued",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "clickup_import_run",
        resourceId: runId.data,
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
