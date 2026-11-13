import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { roleAtLeast } from "@/lib/auth/types";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import {
  canonicalizarCorpoDaVisao,
  corpoDaVisaoSchema,
  type VisaoSalvaDoFunil,
} from "@/lib/kanban/visoes-salvas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const pipelineIdSchema = z.string().uuid();
const COLUNAS =
  "id, organization_id, pipeline_id, owner_user_id, created_by, name, visibility, view_type, filters, sort_config, view_config, schema_version, position, created_at, updated_at";

export async function GET(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_pipeline_views" });
  if (!authz.ok) return authz.response;
  const pipelineId = pipelineIdSchema.safeParse((await ctx.params).id);
  if (!pipelineId.success) return fail("not_found", "Funil não encontrado.", 404, { requestId });
  const db = await createClient();
  const { data: funil } = await db
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", pipelineId.data)
    .maybeSingle();
  if (!funil) return fail("not_found", "Funil não encontrado.", 404, { requestId });
  const { data, error } = await db
    .from("crm_pipeline_views")
    .select(COLUNAS)
    .eq("organization_id", authz.org.orgId)
    .eq("pipeline_id", pipelineId.data)
    .order("position")
    .order("id");
  if (error) {
    logger.error("[pipeline-views.list] query failed", {
      requestId,
      code: error.code,
      erro: error.message,
    });
    return fail("internal_error", "Não foi possível carregar as visualizações.", 500, {
      requestId,
    });
  }
  return ok((data ?? []) as unknown as VisaoSalvaDoFunil[], { requestId });
}

export async function POST(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_pipeline_views" });
  if (!authz.ok) return authz.response;
  const pipelineId = pipelineIdSchema.safeParse((await ctx.params).id);
  if (!pipelineId.success) return fail("not_found", "Funil não encontrado.", 404, { requestId });
  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", "Corpo não é JSON válido.", 400, { requestId });
  }
  const parsed = corpoDaVisaoSchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Visualização inválida.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }
  const corpo = canonicalizarCorpoDaVisao(parsed.data);
  if (corpo.visibility === "shared" && !roleAtLeast(authz.org.role, "manager")) {
    return fail("forbidden", "Somente gestores compartilham visualizações.", 403, { requestId });
  }
  const db = await createClient();
  const { data: funil } = await db
    .from("crm_pipelines")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", pipelineId.data)
    .maybeSingle();
  if (!funil) return fail("not_found", "Funil não encontrado.", 404, { requestId });
  const { data: ultima } = await db
    .from("crm_pipeline_views")
    .select("position")
    .eq("organization_id", authz.org.orgId)
    .eq("pipeline_id", pipelineId.data)
    .order("position", { ascending: false })
    .limit(1)
    .maybeSingle();
  const row = {
    organization_id: authz.org.orgId,
    pipeline_id: pipelineId.data,
    owner_user_id: corpo.visibility === "personal" ? authz.user.id : null,
    created_by: authz.user.id,
    ...corpo,
    schema_version: 1,
    position: Number((ultima as { position?: number } | null)?.position ?? 0) + 1000,
  };
  const { data, error } = await db.from("crm_pipeline_views").insert(row).select(COLUNAS).single();
  if (error) {
    if (error.code === "23505") {
      return fail("state_conflict", "Já existe uma visualização com esse nome.", 409, {
        requestId,
      });
    }
    logger.error("[pipeline-views.create] insert failed", {
      requestId,
      code: error.code,
      erro: error.message,
    });
    return fail("internal_error", "Não foi possível salvar a visualização.", 500, { requestId });
  }
  void audit({
    action: "pipeline_view.created",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "crm_pipeline_view",
    resourceId: (data as { id: string }).id,
    requestId,
    metadata: { visibility: corpo.visibility, view_type: corpo.view_type },
  });
  return ok(data as unknown as VisaoSalvaDoFunil, { status: 201, requestId });
}
