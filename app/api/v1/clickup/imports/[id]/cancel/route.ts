import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { clickupRunIdSchema } from "@/lib/clickup/contrato";
import { cancelClickUpRun } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure } from "../../../_shared";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(_request: Request, context: RouteContext): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "clickup_import_runs",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const runId = clickupRunIdSchema.safeParse((await context.params).id);
  if (!runId.success) return fail("validation_failed", "Importação inválida.", 422, { requestId });
  try {
    const data = await cancelClickUpRun(createAdminClient(), authz.org.orgId, runId.data);
    void audit({
      action: "clickup.import_cancelled",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "clickup_import_run",
      resourceId: runId.data,
      requestId,
      bypassedRls: true,
      metadata: { cancellation_requested: data.status === "running" },
    });
    return ok(data, { requestId });
  } catch (error) {
    return clickupFailure(error, requestId);
  }
}
