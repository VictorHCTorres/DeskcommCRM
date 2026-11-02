import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { areaAtiva, listarGruposDeFunil, proximaPosicao } from "@/lib/pipelines/grupos";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    kind: z.enum(["area", "grupo"]),
    parent_id: z.string().uuid().nullable().optional(),
  })
  .strict();

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_pipeline_groups" });
  if (!authz.ok) return authz.response;
  try {
    const db = (await createClient()) as unknown as SupabaseClient;
    const incluiArquivados = req.nextUrl.searchParams.get("include_archived") === "true";
    return ok(await listarGruposDeFunil(db, authz.org.orgId, incluiArquivados), { requestId });
  } catch (error) {
    return fail("internal_error", (error as Error).message, 500, { requestId });
  }
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipeline_groups" });
  if (!authz.ok) return authz.response;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", "Corpo não é JSON válido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Dê um nome e escolha Área ou Grupo.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = (await createClient()) as unknown as SupabaseClient;
  const organizationId = authz.org.orgId;
  try {
    const existentes = await listarGruposDeFunil(db, organizationId, true);
    const parentId = parsed.data.kind === "grupo" ? (parsed.data.parent_id ?? null) : null;
    if (parsed.data.kind === "grupo" && !areaAtiva(existentes, parentId)) {
      return fail("unprocessable_entity", "Escolha uma Área ativa para este Grupo.", 422, {
        requestId,
      });
    }
    const row = {
      organization_id: organizationId,
      name: parsed.data.name,
      kind: parsed.data.kind,
      parent_id: parentId,
      position: proximaPosicao(existentes, parentId),
    };
    const { data, error } = await db.from("crm_pipeline_groups").insert(row).select("id").single();
    if (error) {
      if (error.code === "23505") {
        return fail("state_conflict", "Já existe um item ativo com esse nome nesse lugar.", 409, {
          requestId,
        });
      }
      return fail("internal_error", error.message, 500, { requestId });
    }
    const id = (data as { id: string }).id;
    void audit({
      action: "pipeline_group.created",
      actorUserId: authz.user.id,
      organizationId,
      resourceType: "crm_pipeline_group",
      resourceId: id,
      requestId,
      metadata: { kind: row.kind, parent_id: row.parent_id, name: row.name },
    });
    return ok(await listarGruposDeFunil(db, organizationId, true), { status: 201, requestId });
  } catch (error) {
    return fail("internal_error", (error as Error).message, 500, { requestId });
  }
}
