import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import {
  clickupConnectionCreateSchema,
  clickupConnectionReceiptIdentity,
  clickupRunIdSchema,
} from "@/lib/clickup/contrato";
import { fingerprintClickUpTokenForIdempotency } from "@/lib/clickup/crypto";
import { createClickUpConnection, listClickUpConnections } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../_shared";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "clickup_connections",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  try {
    const data = await listClickUpConnections(createAdminClient(), authz.org.orgId);
    return ok(data, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return clickupFailure(error, requestId);
  }
}

export async function POST(request: Request): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("admin", {
    requestId,
    resource: "clickup_connections",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const idempotencyKey = chaveDaRequisicao(request);
  if (!idempotencyKey || !clickupRunIdSchema.safeParse(idempotencyKey).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID.", 400, { requestId });
  }
  const body = clickupConnectionCreateSchema.safeParse(await readJson(request));
  if (!body.success) {
    return fail("validation_failed", "Conexão do ClickUp inválida.", 422, {
      requestId,
      details: body.error.flatten(),
    });
  }
  try {
    const db = createAdminClient();
    const outcome = await comIdempotencia({
      db,
      organizationId: authz.org.orgId,
      endpoint: "clickup.connections.create",
      chave: idempotencyKey,
      // O token não entra no recibo. Um HMAC keyed entra apenas na identidade
      // que será novamente resumida por `comIdempotencia` antes de persistir.
      corpo: clickupConnectionReceiptIdentity(
        body.data,
        fingerprintClickUpTokenForIdempotency(body.data.token),
      ),
      executar: async () => ({
        resposta: await createClickUpConnection(db, {
          organizationId: authz.org.orgId,
          userId: authz.user.id,
          workspaceId: body.data.workspace_id,
          workspaceName: body.data.workspace_name,
          token: body.data.token,
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
        action: "clickup.connection_created",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "clickup_connection",
        resourceId: data.id,
        requestId,
        bypassedRls: true,
        metadata: { workspace_id: body.data.workspace_id },
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
