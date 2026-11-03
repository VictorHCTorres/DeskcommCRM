import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import {
  chaveDaRequisicao,
  comIdempotencia,
  JANELA_LONGA_DA_RESERVA_MS,
} from "@/lib/api/idempotency";
import { requireRole } from "@/lib/auth/require-role";
import { clickupDiscoverySchema, clickupRunIdSchema } from "@/lib/clickup/contrato";
import { discoverClickUpCrmApi } from "@/lib/clickup/crm/discovery-api";
import { decryptClickUpToken } from "@/lib/clickup/crypto";
import { canonicalizeClickUpManifest, manifestHash } from "@/lib/clickup/manifest";
import { loadClickUpConnectionSecret, stageClickUpPreview } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../_shared";

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
  const body = clickupDiscoverySchema.safeParse(await readJson(request));
  if (!body.success) {
    return fail("validation_failed", "Pedido de descoberta inválido.", 422, { requestId });
  }
  const idempotencyKey = chaveDaRequisicao(request);
  if (!idempotencyKey || !clickupRunIdSchema.safeParse(idempotencyKey).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID.", 400, { requestId });
  }
  try {
    const db = createAdminClient();
    const outcome = await comIdempotencia({
      db,
      organizationId: authz.org.orgId,
      endpoint: "clickup.discovery.stage",
      chave: idempotencyKey,
      corpo: body.data,
      reservaMs: JANELA_LONGA_DA_RESERVA_MS,
      executar: async () => {
        const connection = await loadClickUpConnectionSecret(
          db,
          authz.org.orgId,
          body.data.connection_id,
        );
        const token = decryptClickUpToken(connection);
        const objects = await discoverClickUpCrmApi({
          workspaceId: connection.workspace_id,
          token,
        });
        const manifest = canonicalizeClickUpManifest({
          connection_id: connection.id,
          workspace_id: connection.workspace_id,
          source: "api",
          scope: "crm",
          manifest_version: 3,
          objects,
        });
        const run = await stageClickUpPreview(db, {
          organizationId: authz.org.orgId,
          userId: authz.user.id,
          manifest,
        });
        return { resposta: { run, snapshot_hash: manifestHash(manifest) }, status: 201 };
      },
    });
    if (outcome.tipo === "conflito") {
      return fail("idempotency_conflict", "A chave já foi usada com outro pedido.", 409, {
        requestId,
      });
    }
    if (outcome.tipo === "em_curso") {
      return fail("idempotency_in_progress", "A descoberta ainda está em processamento.", 409, {
        requestId,
      });
    }
    return ok(outcome.resposta, {
      status: 201,
      requestId,
      headers: outcome.tipo === "replay" ? { "Idempotency-Replayed": "true" } : undefined,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("clickup_task_multiple_lists:")) {
      return fail(
        "conflict",
        "Uma Task aparece em mais de uma List. Escolha uma List principal antes de importar.",
        409,
        { requestId },
      );
    }
    if (error instanceof Error && error.message.startsWith("clickup_api_")) {
      return fail("upstream_error", "Não foi possível concluir a descoberta no ClickUp.", 502, {
        requestId,
      });
    }
    return clickupFailure(error, requestId);
  }
}
