import { randomUUID } from "node:crypto";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { clickupRunIdSchema } from "@/lib/clickup/contrato";
import { CLICKUP_ASSET_MAX_BYTES, CLICKUP_SIDECAR_MAX_BYTES } from "@/lib/clickup/sidecar-contrato";
import { prepareClickUpAssetUpload } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../../../../_shared";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    kind: z.enum(["sidecar", "asset"]),
    attachment_id: z.string().trim().min(1).max(512).optional(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    declared_size: z.number().int().min(1).max(CLICKUP_SIDECAR_MAX_BYTES),
  })
  .strict()
  .superRefine((body, context) => {
    if ((body.kind === "asset") !== Boolean(body.attachment_id)) {
      context.addIssue({ code: "custom", path: ["attachment_id"], message: "Vínculo inválido." });
    }
    if (body.kind === "asset" && body.declared_size > CLICKUP_ASSET_MAX_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["declared_size"],
        message: "Asset excede 10 MiB.",
      });
    }
  });

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
  const runId = clickupRunIdSchema.safeParse((await context.params).id);
  const body = bodySchema.safeParse(await readJson(request));
  if (!runId.success || !body.success) {
    return fail("validation_failed", "Upload de asset inválido.", 422, { requestId });
  }
  try {
    const db = createAdminClient();
    const limit = await checkRateLimit(`clickup-asset-prepare:${authz.org.orgId}`, 100, 60);
    if (!limit.allowed) {
      return fail("rate_limited", "Muitos uploads preparados. Tente novamente em instantes.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    }
    const upload = await prepareClickUpAssetUpload(db, {
      organizationId: authz.org.orgId,
      userId: authz.user.id,
      runId: runId.data,
      kind: body.data.kind,
      attachmentId: body.data.attachment_id,
      sha256: body.data.sha256,
      declaredSize: body.data.declared_size,
    });
    const { data, error } = await db.storage
      .from(body.data.kind === "sidecar" ? "clickup-sidecars" : "clickup-assets")
      .createSignedUploadUrl(String(upload.storage_path));
    if (error || !data) throw new Error("clickup_asset_signed_upload_unavailable");
    void audit({
      action: "clickup.asset_upload_prepared",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "clickup_asset_upload",
      resourceId: String(upload.id),
      requestId,
      bypassedRls: true,
      metadata: {
        run_id: runId.data,
        kind: body.data.kind,
        declared_size: body.data.declared_size,
      },
    });
    return ok(
      {
        upload_id: upload.id,
        token: data.token,
        path: upload.storage_path,
        expires_at: upload.expires_at,
      },
      { status: 201, requestId },
    );
  } catch (error) {
    return clickupFailure(error, requestId);
  }
}
