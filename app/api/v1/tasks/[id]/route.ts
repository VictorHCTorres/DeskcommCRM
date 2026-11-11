import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * PATCH  /api/v1/tasks/[id] — edita uma tarefa.
 * DELETE /api/v1/tasks/[id] — apaga uma tarefa.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code), sem o fallback para
 * `custom_fields.tasks` — o motivo inteiro está no cabeçalho de
 * `app/api/v1/tasks/route.ts`.
 *
 * ⚠️ O `.eq("organization_id", ...)` não é decoração: sem ele o PATCH casaria
 * 0 linhas numa tarefa de outra organização e o PostgREST devolveria `PGRST116`
 * — que esta rota já traduz para 404, o desfecho certo. Mantê-lo explícito é a
 * regra do CLAUDE.md e o que segura o dia em que alguém trocar o client.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import {
  chaveExternaSchema,
  comSinalDeCapacidade,
  ehConflitoDaChave,
} from "@/lib/tarefas/chave-externa";
import { buscarDonaDaChave } from "@/lib/tarefas/dona-da-chave";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import { conferirResponsavel } from "@/lib/tarefas/responsavel";
import { COLUNAS_DA_TAREFA } from "@/lib/tarefas/gravar-tarefa";
import { instanteAposConclusao } from "@/lib/tarefas/recorrencia";
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA, type Tarefa } from "@/lib/tarefas/tipos";
import { conferirVinculosDaTarefa } from "@/lib/tarefas/vinculos";

export const dynamic = "force-dynamic";

const COLUNAS = COLUNAS_DA_TAREFA;

const edicaoSchema = z
  .object({
    title: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(5000).nullable().optional(),
    due_date: z.string().datetime({ offset: true }).nullable().optional(),
    priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
    status: z.enum(SITUACOES_DA_TAREFA).optional(),
    lead_id: z.string().uuid().nullable().optional(),
    contact_id: z.string().uuid().nullable().optional(),
    /** Vincular (`<uuid>`) e desvincular (`null`) a demanda do atendimento (#2818). */
    demanda_id: z.string().uuid().nullable().optional(),
    assigned_to: z.string().uuid().nullable().optional(),
    /**
     * D9 — ADOTAR: preenche a chave de uma tarefa que ainda não tem (gravada antes da D9).
     * Trocar uma chave existente ou apagá-la (`null`) é recusado: `null` nem passa neste schema.
     */
    external_id: chaveExternaSchema.optional(),
  })
  // PATCH vazio gravaria só o `updated_at` e devolveria 200: a tela diria
  // "salvo" sobre uma edição que não existiu.
  .refine((v) => Object.keys(v).length > 0, { message: "Nada para alterar." });

/**
 * O `update` da edição. Com `somenteSeSemChave`, leva `external_id is null` na própria instrução
 * (a adoção da D9); sem ela, é a edição comum de sempre.
 */
async function gravarEdicao(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  id: string,
  campos: Record<string, unknown>,
  somenteSeSemChave: boolean,
) {
  let atualiza = supabase
    .from("crm_tasks")
    .update(campos as never)
    .eq("id", id)
    .eq("organization_id", orgId);
  if (somenteSeSemChave) atualiza = atualiza.is("external_id", null);
  return atualiza.select(COLUNAS).single();
}

interface Contexto {
  params: Promise<{ id: string }>;
}

/** O sinal de capacidade (contrato D9 §3) vai em toda resposta do PATCH, inclusive nas recusas. */
export async function PATCH(req: NextRequest, ctx: Contexto): Promise<Response> {
  return comSinalDeCapacidade(await editar(req, ctx));
}

async function editar(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  // Sessão OU token de servidor (`dsk_…` com `mcp:write`): o robô que vigia a
  // CND muda a situação da tarefa por aqui. O DELETE abaixo continua só de tela.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_tasks",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const orgId = authz.organizationId;
  const usuario = authz.via === "session" && authz.actor.type === "user" ? authz.actor.id : null;

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "tasks", requestId);
  if (tetoEstourado) return tetoEstourado;

  const parsed = edicaoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  if (parsed.data.assigned_to) {
    // A chave estrangeira de `assigned_to` é só para `auth.users`: sem esta conferência, um id de
    // outra organização (ou de quem saiu da equipe) gravaria sem erro. A régua
    // e o porquê do admin client estão em `lib/tarefas/responsavel.ts`.
    const equipe = isServiceRoleConfigured() ? createAdminClient() : await createClient();
    const veredito = await conferirResponsavel(equipe, orgId, parsed.data.assigned_to);
    if (veredito === "falha_na_consulta") {
      return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    }
    if (veredito === "fora_da_equipe") {
      return fail("validation_failed", t("O responsável escolhido não faz parte da equipe."), 422, {
        requestId,
      });
    }
  }

  const supabase = authz.supabase;

  const vereditoDosVinculos = await conferirVinculosDaTarefa(supabase, orgId, parsed.data);
  if (vereditoDosVinculos === "falha_na_consulta") {
    return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
  }
  if (vereditoDosVinculos === "fora_da_organizacao") {
    return fail(
      "validation_failed",
      t("O negócio, o contato ou a demanda vinculada não existe."),
      422,
      { requestId },
    );
  }

  if (parsed.data.demanda_id) {
    // A chave estrangeira não passa pela RLS: sem esta conferência, a demanda
    // de outra organização gravaria sem erro. A régua está em `lib/tarefas/demanda.ts`.
    const veredito = await conferirDemanda(supabase, orgId, parsed.data.demanda_id);
    if (veredito === "falha_na_consulta") {
      return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    }
    if (veredito === "fora_da_organizacao") {
      return fail(
        "validation_failed",
        t("O negócio, o contato ou a demanda vinculada não existe."),
        422,
        {
          requestId,
        },
      );
    }
    if (veredito === "encerrada") {
      return fail(
        "state_conflict",
        t("Esta demanda já foi encerrada. Crie a tarefa numa demanda em andamento."),
        409,
        {
          requestId,
        },
      );
    }
  }

  // A situação ANTES da edição decide se esta é a vez em que a tarefa fechou.
  // Sem ler antes, marcar "concluída" duas vezes emitiria duas linhas na
  // timeline do negócio — e a segunda seria mentira.
  const { data: antes } = await supabase
    .from("crm_tasks")
    .select("status, recurrence_id")
    .eq("id", id)
    .eq("organization_id", orgId)
    .maybeSingle();

  // Adoção da chave (D9): o `update` leva `external_id is null` NA MESMA instrução, então duas
  // adoções concorrentes não se atropelam — só uma casa a linha. Não há leitura-depois-escrita.
  const adota = parsed.data.external_id !== undefined;
  let campos: Record<string, unknown> = parsed.data;
  let { data, error } = await gravarEdicao(supabase, orgId, id, campos, adota);

  if (error && (error as { code?: string }).code === "PGRST116" && adota) {
    // Nenhuma linha casou: a tarefa não existe, ou já tem chave. Só uma leitura diz qual.
    const { data: atual, error: erroLeitura } = await supabase
      .from("crm_tasks")
      .select(COLUNAS)
      .eq("id", id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (erroLeitura)
      return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    if (!atual) return fail("not_found", t("Tarefa não encontrada."), 404, { requestId });
    const existente = (atual as unknown as Tarefa).external_id ?? null;
    if (existente !== parsed.data.external_id) {
      return fail(
        "state_conflict",
        t("Esta tarefa já tem outra chave externa; ela não se troca."),
        409,
        {
          requestId,
          details: { reason: "external_id_already_set", external_id: existente },
        },
      );
    }
    // A MESMA chave de novo (o robô repetindo a adoção): não há o que gravar na chave. O resto
    // do corpo, se houver, segue pelo caminho comum.
    const { external_id: _ja, ...resto } = parsed.data;
    if (Object.keys(resto).length === 0) {
      data = atual;
      error = null;
    } else {
      campos = resto;
      ({ data, error } = await gravarEdicao(supabase, orgId, id, campos, false));
    }
  }

  if (error) {
    if (error.code === "PGRST116") {
      return fail("not_found", t("Tarefa não encontrada."), 404, { requestId });
    }
    if (error.code === "23503") {
      return fail(
        "validation_failed",
        t("O negócio, o contato ou a demanda vinculada não existe."),
        422,
        {
          requestId,
        },
      );
    }
    if (adota && ehConflitoDaChave(error)) {
      const dona = await buscarDonaDaChave(supabase, orgId, parsed.data.external_id!);
      if (dona === "incerto") {
        return fail(
          "unavailable",
          t(
            "Não foi possível confirmar qual tarefa já tem esta chave. O resultado é incerto: consulte a lista pela chave antes de tentar de novo.",
          ),
          503,
          { requestId, details: { external_id: parsed.data.external_id, outcome: "unknown" } },
        );
      }
      return fail("state_conflict", t("Já existe uma tarefa com esta chave externa."), 409, {
        requestId,
        details: { external_id: parsed.data.external_id, task_id: dona },
      });
    }
    return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
  }

  const tarefa = data as unknown as Tarefa;

  await audit({
    organizationId: orgId,
    actorUserId: usuario,
    actorApiTokenId: authz.apiTokenId ?? null,
    bypassedRls: authz.via === "token",
    action: "crm_task.updated",
    resourceType: "crm_tasks",
    resourceId: tarefa.id,
    requestId,
    metadata: { campos: Object.keys(campos) },
  });

  const fechouAgora =
    tarefa.status === "done" && (antes as { status?: string } | null)?.status !== "done";
  if (fechouAgora) {
    await registraAtividadeDaTarefa(supabase, {
      organizationId: orgId,
      tarefa,
      tipo: "task_completed",
      actor: authz.actor,
    });

    const recurrenceId = (antes as { recurrence_id?: string | null } | null)?.recurrence_id;
    if (recurrenceId) {
      const { data: recorrencia } = await supabase
        .from("crm_task_recurrences" as never)
        .select("id, frequency, interval, mode, timezone, active, current_task_id" as never)
        .eq("id", recurrenceId)
        .eq("organization_id", orgId)
        .maybeSingle();
      const regra = recorrencia as unknown as {
        id: string;
        frequency: "daily" | "weekly" | "monthly";
        interval: number;
        mode: "on_schedule" | "after_completion";
        timezone: string;
        active: boolean;
        current_task_id: string | null;
      } | null;
      if (regra?.active && regra.mode === "after_completion" && regra.current_task_id === id) {
        const agora = new Date();
        const proxima = instanteAposConclusao(agora, regra).toISOString();
        await supabase
          .from("crm_task_recurrences" as never)
          .update({ next_run_at: agora.toISOString(), next_due_at: proxima } as never)
          .eq("id", regra.id)
          .eq("organization_id", orgId)
          .eq("current_task_id", id)
          .is("next_run_at", null);
      }
    }
  }

  return ok({ task: tarefa }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const supabase = await createClient();
  const { data: alvo } = await supabase
    .from("crm_tasks")
    .select("id, recurrence_id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!alvo) return fail("not_found", t("Tarefa não encontrada."), 404, { requestId });
  if ((alvo as { recurrence_id?: string | null }).recurrence_id) {
    const { data: serie } = await supabase
      .from("crm_task_recurrences" as never)
      .select("active, current_task_id" as never)
      .eq("id", (alvo as { recurrence_id: string }).recurrence_id)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    const ativa = serie as unknown as { active: boolean; current_task_id: string | null } | null;
    if (ativa?.active && ativa.current_task_id === id) {
      return fail(
        "state_conflict",
        t("Cancele a recorrência antes de apagar a ocorrência atual."),
        409,
        { requestId },
      );
    }
  }
  // `.select()` no delete para saber se ALGUMA linha saiu. Sem isso, apagar uma
  // tarefa de outra organização devolveria 200 — e a tela sumiria com a linha
  // do próprio usuário na próxima recarga, sem que nada tivesse sido apagado.
  const { data, error } = await supabase
    .from("crm_tasks")
    .delete()
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .select("id");

  if (error) {
    return fail("internal_error", t("Erro ao apagar a tarefa."), 500, { requestId });
  }
  if (!data || data.length === 0) {
    return fail("not_found", t("Tarefa não encontrada."), 404, { requestId });
  }

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "crm_task.deleted",
    resourceType: "crm_tasks",
    resourceId: id,
    requestId,
  });

  return ok({ deleted: true }, { requestId });
}
