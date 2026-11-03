import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { clickupMappingSchema, clickupRunIdSchema } from "@/lib/clickup/contrato";
import { updateClickUpMapping } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../../../_shared";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, context: RouteContext): Promise<Response> {
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
  const body = clickupMappingSchema.safeParse(await readJson(request));
  if (!runId.success || !body.success) {
    return fail("validation_failed", "Mapeamento do ClickUp inválido.", 422, { requestId });
  }
  try {
    const data = await updateClickUpMapping(createAdminClient(), {
      organizationId: authz.org.orgId,
      runId: runId.data,
      expectedRevision: body.data.expected_revision,
      mapping: body.data.mapping,
    });
    void audit({
      action: "clickup.import_mapping_updated",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "clickup_import_run",
      resourceId: runId.data,
      requestId,
      bypassedRls: true,
      metadata: {
        mapping_revision: data.mapping_revision,
        preview_revision: data.preview_revision,
      },
    });
    return ok(data, { requestId });
  } catch (error) {
    return clickupFailure(error, requestId);
  }
}
