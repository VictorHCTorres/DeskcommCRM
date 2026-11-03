import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { escreveComoPlatformAdmin, roleAtLeast } from "@/lib/auth/types";
import { clickupManifestSchema, clickupRunIdSchema } from "@/lib/clickup/contrato";
import {
  AVISO_DOC_PRIVADO_CLICKUP,
  estadoDaPrivacidadeDosDocs,
} from "@/lib/clickup/docs/privacidade";
import { canonicalizeClickUpManifest } from "@/lib/clickup/manifest";
import { stageClickUpPreview } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../../_shared";

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
  const idempotencyKey = chaveDaRequisicao(request);
  if (!idempotencyKey || !clickupRunIdSchema.safeParse(idempotencyKey).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID.", 400, { requestId });
  }
  const parsed = clickupManifestSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return fail("validation_failed", "Manifesto do ClickUp inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const privacidade = estadoDaPrivacidadeDosDocs(parsed.data);
  if (
    privacidade.temPrivado &&
    !roleAtLeast(authz.org.role, "admin") &&
    !escreveComoPlatformAdmin(authz.user)
  ) {
    return fail("forbidden_role", "Somente administradores podem incluir Docs privados.", 403, {
      requestId,
    });
  }
  if (privacidade.temPrivado && !privacidade.inclusaoExplicita) {
    return fail(
      "validation_failed",
      "Confirme explicitamente que Docs privados ficarão visíveis para toda a organização.",
      422,
      { requestId },
    );
  }
  try {
    const db = createAdminClient();
    const outcome = await comIdempotencia({
      db,
      organizationId: authz.org.orgId,
      endpoint: "clickup.imports.preview",
      chave: idempotencyKey,
      corpo: parsed.data,
      executar: async () => ({
        resposta: await stageClickUpPreview(db, {
          organizationId: authz.org.orgId,
          userId: authz.user.id,
          manifest: canonicalizeClickUpManifest(parsed.data),
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
        action: "clickup.import_previewed",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "clickup_import_run",
        resourceId: data.id,
        requestId,
        bypassedRls: true,
        metadata: {
          source: data.source,
          scope: data.scope,
          total_items: data.total_items,
          warnings_count: data.warnings_count,
        },
      });
    }
    return ok(
      privacidade.temPrivado ? { ...data, privacy_warning: AVISO_DOC_PRIVADO_CLICKUP } : data,
      {
        status: 201,
        requestId,
        headers: outcome.tipo === "replay" ? { "Idempotency-Replayed": "true" } : undefined,
      },
    );
  } catch (error) {
    return clickupFailure(error, requestId);
  }
}
