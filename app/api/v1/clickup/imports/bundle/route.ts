import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import {
  chaveDaRequisicao,
  comIdempotencia,
  JANELA_LONGA_DA_RESERVA_MS,
} from "@/lib/api/idempotency";
import { requireRole } from "@/lib/auth/require-role";
import { clickupManifestSchema, clickupRunIdSchema } from "@/lib/clickup/contrato";
import { canonicalizeClickUpManifest } from "@/lib/clickup/manifest";
import { stageClickUpPreview } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../../_shared";

const BUCKET = "clickup-import-staging";
const MAX_BYTES = 20 * 1024 * 1024;
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("prepare") }).strict(),
  z.object({ action: z.literal("stage"), path: z.string().min(1).max(500) }).strict(),
]);

export async function POST(request: Request): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "clickup_import_runs",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const parsed = bodySchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return fail("validation_failed", "Pedido de bundle inválido.", 422, { requestId });
  }
  const db = createAdminClient();
  try {
    if (parsed.data.action === "prepare") {
      const path = `${authz.org.orgId}/${authz.user.id}/${randomUUID()}.json`;
      const { data, error } = await db.storage.from(BUCKET).createSignedUploadUrl(path);
      if (error || !data) throw new Error("clickup_bundle_upload_unavailable");
      return ok({ path, token: data.token }, { status: 201, requestId });
    }
    const bundlePath = parsed.data.path;
    const prefix = `${authz.org.orgId}/${authz.user.id}/`;
    if (!bundlePath.startsWith(prefix) || !bundlePath.endsWith(".json")) {
      return fail("forbidden", "Bundle fora do escopo desta organização.", 403, { requestId });
    }
    const idempotencyKey = chaveDaRequisicao(request);
    if (!idempotencyKey || !clickupRunIdSchema.safeParse(idempotencyKey).success) {
      return fail("validation_error", "Idempotency-Key deve ser UUID.", 400, { requestId });
    }
    const outcome = await comIdempotencia({
      db,
      organizationId: authz.org.orgId,
      endpoint: "clickup.bundle.stage",
      chave: idempotencyKey,
      corpo: { path: bundlePath },
      reservaMs: JANELA_LONGA_DA_RESERVA_MS,
      executar: async () => {
        const storage = db.storage.from(BUCKET);
        try {
          const { data: file, error } = await storage.download(bundlePath);
          if (error || !file || file.size > MAX_BYTES) {
            throw new Error("clickup_bundle_missing_or_large");
          }
          let raw: unknown;
          try {
            raw = JSON.parse(await file.text());
          } catch {
            throw new Error("clickup_bundle_invalid_json");
          }
          const manifest = clickupManifestSchema.safeParse(raw);
          if (!manifest.success || manifest.data.source !== "bundle") {
            throw new Error("clickup_bundle_invalid_manifest");
          }
          if (manifest.data.scope !== "crm") throw new Error("clickup_bundle_scope_not_crm");
          const run = await stageClickUpPreview(db, {
            organizationId: authz.org.orgId,
            userId: authz.user.id,
            manifest: canonicalizeClickUpManifest(manifest.data),
          });
          return { resposta: { run }, status: 201 };
        } finally {
          await storage.remove([bundlePath]);
        }
      },
    });
    if (outcome.tipo === "conflito") {
      return fail("idempotency_conflict", "A chave já foi usada com outro bundle.", 409, {
        requestId,
      });
    }
    if (outcome.tipo === "em_curso") {
      return fail("idempotency_in_progress", "O bundle ainda está em processamento.", 409, {
        requestId,
      });
    }
    return ok(outcome.resposta, {
      status: 201,
      requestId,
      headers: outcome.tipo === "replay" ? { "Idempotency-Replayed": "true" } : undefined,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "clickup_bundle_scope_not_crm") {
      return fail(
        "validation_failed",
        "Esta rota aceita somente bundles CRM. Docs exigem o fluxo administrativo com consentimento explícito.",
        422,
        { requestId },
      );
    }
    if (error instanceof Error && error.message.startsWith("clickup_bundle_")) {
      return fail("validation_failed", "Bundle ausente, grande demais ou inválido.", 422, {
        requestId,
      });
    }
    return clickupFailure(error, requestId);
  }
}
