import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  areaAtiva,
  listarGruposDeFunil,
  podeRestaurarGrupo,
  posicaoDepoisDeGrupo,
} from "@/lib/pipelines/grupos";
import { createClient } from "@/lib/supabase/server";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    parent_id: z.string().uuid().optional(),
    archived: z.boolean().optional(),
    /** Vizinho imediatamente acima; `null` move para o começo. Nunca aceita posição crua. */
    depois_de: z.string().uuid().nullable().optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: "Nada para alterar." });

export async function PATCH(req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "crm_pipeline_groups" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;

  let json: unknown;
  try {
    json = await req.json();
  } catch {
    return fail("invalid_request", "Corpo não é JSON válido.", 400, { requestId });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return fail("unprocessable_entity", "Não entendi o que mudar.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const db = (await createClient()) as unknown as SupabaseClient;
  const organizationId = authz.org.orgId;
  try {
    const grupos = await listarGruposDeFunil(db, organizationId, true);
    const alvo = grupos.find((grupo) => grupo.id === id);
    if (!alvo) return fail("not_found", "Área ou Grupo não encontrado.", 404, { requestId });

    if (parsed.data.parent_id !== undefined) {
      if (alvo.kind !== "grupo" || !areaAtiva(grupos, parsed.data.parent_id)) {
        return fail(
          "unprocessable_entity",
          "Um Grupo só pode ser movido para uma Área ativa.",
          422,
          {
            requestId,
          },
        );
      }
    }
    if (
      parsed.data.archived === false &&
      alvo.kind === "grupo" &&
      !podeRestaurarGrupo(grupos, alvo, parsed.data.parent_id)
    ) {
      return fail(
        "state_conflict",
        "A Área deste Grupo está arquivada. Tire a Área do arquivo antes de restaurar o Grupo.",
        409,
        { requestId },
      );
    }
    if (parsed.data.archived === true && alvo.kind === "area") {
      const filhosAtivos = grupos.filter(
        (grupo) => grupo.parent_id === id && grupo.archived_at === null,
      );
      if (filhosAtivos.length > 0) {
        return fail(
          "state_conflict",
          `A Área ainda tem ${filhosAtivos.length} Grupo(s) ativo(s). Mova ou arquive esses Grupos primeiro.`,
          409,
          { requestId },
        );
      }
    }

    const patch: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.parent_id !== undefined) patch.parent_id = parsed.data.parent_id;
    if (parsed.data.archived !== undefined) {
      patch.archived_at = parsed.data.archived ? new Date().toISOString() : null;
    }
    const parentFinal = alvo.kind === "area" ? null : (parsed.data.parent_id ?? alvo.parent_id);
    if (parsed.data.parent_id !== undefined && parsed.data.depois_de === undefined) {
      const irmaos = grupos.filter(
        (grupo) =>
          grupo.id !== id &&
          grupo.kind === alvo.kind &&
          grupo.parent_id === parentFinal &&
          grupo.archived_at === null,
      );
      patch.position = Math.max(0, ...irmaos.map((grupo) => Number(grupo.position))) + 1000;
    }
    if (parsed.data.depois_de !== undefined) {
      const novaPosicao = posicaoDepoisDeGrupo(grupos, alvo, parentFinal, parsed.data.depois_de);
      if (!novaPosicao.ok && novaPosicao.motivo === "vizinho_invalido") {
        return fail("unprocessable_entity", "O vizinho escolhido não está nessa lista.", 422, {
          requestId,
        });
      }
      if (!novaPosicao.ok) {
        return fail(
          "state_conflict",
          "A ordenação está empatada. Recarregue e tente de novo.",
          409,
          {
            requestId,
          },
        );
      }
      patch.position = novaPosicao.position;
    }
    const { error } = await db
      .from("crm_pipeline_groups")
      .update(patch)
      .eq("id", id)
      .eq("organization_id", organizationId);
    if (error) {
      if (error.code === "23505") {
        return fail("state_conflict", "Já existe um item ativo com esse nome nesse lugar.", 409, {
          requestId,
        });
      }
      return fail("internal_error", error.message, 500, { requestId });
    }
    void audit({
      action: parsed.data.archived === true ? "pipeline_group.archived" : "pipeline_group.updated",
      actorUserId: authz.user.id,
      organizationId,
      resourceType: "crm_pipeline_group",
      resourceId: id,
      requestId,
      metadata: { kind: alvo.kind, pedido: parsed.data },
    });
    return ok(await listarGruposDeFunil(db, organizationId, true), { requestId });
  } catch (error) {
    return fail("internal_error", (error as Error).message, 500, { requestId });
  }
}
