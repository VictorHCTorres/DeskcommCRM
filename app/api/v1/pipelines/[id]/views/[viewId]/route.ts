import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  canonicalizarCorpoDaVisao,
  corpoBaseDaVisaoSchema,
  corpoDaVisaoSchema,
  type VisaoSalvaDoFunil,
} from "@/lib/kanban/visoes-salvas";
import { createClient } from "@/lib/supabase/server";

interface RouteCtx {
  params: Promise<{ id: string; viewId: string }>;
}

const uuid = z.string().uuid();
const patchSchema = corpoBaseDaVisaoSchema
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0);
const COLUNAS =
  "id, organization_id, pipeline_id, owner_user_id, created_by, name, visibility, view_type, filters, sort_config, view_config, schema_version, position, created_at, updated_at";

async function contexto(ctx: RouteCtx, requestId: string) {
  const authz = await requireRole("viewer", { requestId, resource: "crm_pipeline_views" });
  if (!authz.ok) return { response: authz.response } as const;
  const ids = await ctx.params;
  if (!uuid.safeParse(ids.id).success || !uuid.safeParse(ids.viewId).success) {
    return {
      response: fail("not_found", "Visualização não encontrada.", 404, { requestId }),
    } as const;
  }
  const db = await createClient();
  const { data } = await db
    .from("crm_pipeline_views")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("pipeline_id", ids.id)
    .eq("id", ids.viewId)
    .maybeSingle();
  if (!data) {
    return {
      response: fail("not_found", "Visualização não encontrada.", 404, { requestId }),
    } as const;
  }
  const view = data as unknown as VisaoSalvaDoFunil;
  const podeEditar =
    view.visibility === "personal"
      ? view.owner_user_id === authz.user.id
      : roleAtLeast(authz.org.role, "manager");
  if (!podeEditar) {
    return {
      response: fail("forbidden", "Você não pode alterar esta visualização.", 403, { requestId }),
    } as const;
  }
  return { response: null, authz, db, ids, view } as const;
}

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const c = await contexto(ctx, requestId);
  if (c.response) return c.response;
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", "Corpo não é JSON válido.", 400, { requestId });
  }
  const parcial = patchSchema.safeParse(json);
  if (!parcial.success) {
    return fail("unprocessable_entity", "Visualização inválida.", 422, {
      requestId,
      details: parcial.error.flatten(),
    });
  }
  const completo = corpoDaVisaoSchema.safeParse({
    name: c.view.name,
    visibility: c.view.visibility,
    view_type: c.view.view_type,
    filters: c.view.filters,
    sort_config: c.view.sort_config,
    view_config: c.view.view_config,
    ...parcial.data,
  });
  if (!completo.success) {
    return fail("unprocessable_entity", "Visualização inválida.", 422, {
      requestId,
      details: completo.error.flatten(),
    });
  }
  const corpo = canonicalizarCorpoDaVisao(completo.data);
  if (corpo.visibility === "shared" && !roleAtLeast(c.authz.org.role, "manager")) {
    return fail("forbidden", "Somente gestores compartilham visualizações.", 403, { requestId });
  }
  const patch = {
    ...corpo,
    owner_user_id: corpo.visibility === "personal" ? c.authz.user.id : null,
    schema_version: 1,
  };
  const { data, error } = await c.db
    .from("crm_pipeline_views")
    .update(patch)
    .eq("organization_id", c.authz.org.orgId)
    .eq("pipeline_id", c.ids.id)
    .eq("id", c.ids.viewId)
    .select(COLUNAS)
    .single();
  if (error) {
    if (error.code === "23505") {
      return fail("state_conflict", "Já existe uma visualização com esse nome.", 409, {
        requestId,
      });
    }
    console.error("[pipeline-views.update] update failed", { requestId, error });
    return fail("internal_error", "Não foi possível atualizar a visualização.", 500, {
      requestId,
    });
  }
  void audit({
    action: "pipeline_view.updated",
    actorUserId: c.authz.user.id,
    organizationId: c.authz.org.orgId,
    resourceType: "crm_pipeline_view",
    resourceId: c.ids.viewId,
    requestId,
    metadata: { visibility: corpo.visibility, view_type: corpo.view_type },
  });
  return ok(data as unknown as VisaoSalvaDoFunil, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const c = await contexto(ctx, requestId);
  if (c.response) return c.response;
  const { error } = await c.db
    .from("crm_pipeline_views")
    .delete()
    .eq("organization_id", c.authz.org.orgId)
    .eq("pipeline_id", c.ids.id)
    .eq("id", c.ids.viewId);
  if (error) {
    console.error("[pipeline-views.delete] delete failed", { requestId, error });
    return fail("internal_error", "Não foi possível excluir a visualização.", 500, { requestId });
  }
  void audit({
    action: "pipeline_view.deleted",
    actorUserId: c.authz.user.id,
    organizationId: c.authz.org.orgId,
    resourceType: "crm_pipeline_view",
    resourceId: c.ids.viewId,
    requestId,
    metadata: { visibility: c.view.visibility, view_type: c.view.view_type },
  });
  return ok({ deleted: true }, { requestId });
}
