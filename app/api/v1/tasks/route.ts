import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * GET  /api/v1/tasks — as tarefas da organização, em ordem de prazo.
 * POST /api/v1/tasks — cria uma tarefa.
 *
 * Extraído do PR #418 (@clinicacentrodosorrisosc-code). Duas coisas do original
 * NÃO vieram, e as duas por motivo escrito:
 *
 *  1. **A lista de "agendamentos" derivada de `custom_fields`.** O GET original
 *     varria `crm_leads` procurando `agendamento_data`, `agendamento_hora`,
 *     `procedimento` e `agendamento_status` e sintetizava itens com título
 *     `🗓️ Fulano (Limpeza)`. Para a clínica dele isso era a agenda inteira; num
 *     produto que já tem `calendar_appointments` (migration 0177) seria uma
 *     SEGUNDA verdade sobre o mesmo compromisso, alimentada por um jsonb sem
 *     schema — e escrita em vocabulário de um nicho só.
 *
 *  2. **O fallback para `custom_fields.tasks` quando a tabela não existe.** O
 *     original capturava `42P01`/`PGRST205` e passava a gravar as tarefas dentro
 *     do lead. Isso existia porque lá a tabela vivia só no `baseline.sql`, sem
 *     migration — quem aplicasse `migrations/` não a teria. Aqui a 0210 fecha
 *     essa lacuna, e o fallback vira o pior tipo de rede: ele transforma "o
 *     banco desta instalação está desatualizado" em sucesso silencioso, com o
 *     dado indo para um lugar que nenhuma lista, índice ou policy alcança.
 *     Falhar aberto na INFORMAÇÃO é o certo aqui: 500 com a mensagem do banco.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit, isServiceRoleConfigured } from "@/lib/audit";
import { resolveAuthDual, tetoDeEscritaDoToken, type AuthDual } from "@/lib/api/auth-dual";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { conferirDemanda } from "@/lib/tarefas/demanda";
import { conferirResponsavel } from "@/lib/tarefas/responsavel";
import { COLUNAS_DA_TAREFA, gravarTarefa } from "@/lib/tarefas/gravar-tarefa";
import { PRIORIDADES_DA_TAREFA, SITUACOES_DA_TAREFA, type Tarefa } from "@/lib/tarefas/tipos";
import { conferirVinculosDaTarefa } from "@/lib/tarefas/vinculos";

export const dynamic = "force-dynamic";

/**
 * Sessão de navegador OU token de servidor (`dsk_…`), mesma dualidade de
 * `PATCH /api/v1/leads/[id]`: os robôs que antes criavam a rotina do mês e a
 * obrigação no ClickUp passam a criar a tarefa aqui, sem navegador. A org sai
 * da sessão ou da LINHA DO TOKEN, nunca do corpo. No ramo do token não há
 * usuário: `created_by` fica nulo (a coluna aceita) e "minhas" não existe.
 */
type Autorizado = Extract<AuthDual, { ok: true }>;
function usuarioDaSessao(authz: Autorizado): string | null {
  return authz.via === "session" && authz.actor.type === "user" ? authz.actor.id : null;
}

/** As colunas que a tela lê. Explícitas para o `select *` não vazar coluna nova. */
const COLUNAS = COLUNAS_DA_TAREFA;

const criacaoSchema = z.object({
  title: z.string().trim().min(1).max(255),
  description: z.string().max(5000).nullable().optional(),
  due_date: z.string().datetime({ offset: true }).nullable().optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).default("medium"),
  status: z.enum(SITUACOES_DA_TAREFA).default("pending"),
  lead_id: z.string().uuid().nullable().optional(),
  contact_id: z.string().uuid().nullable().optional(),
  // O vínculo com o ASSUNTO do atendimento (#2818): é o que faz a tarefa
  // criada de dentro da conversa voltar para a tela de quem precisa cumpri-la.
  // Opcional como os outros dois — a tarefa avulsa é caso real.
  demanda_id: z.string().uuid().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
  parent_task_id: z.string().uuid().nullable().optional(),
});

const listaSchema = z.object({
  status: z.enum(SITUACOES_DA_TAREFA).optional(),
  priority: z.enum(PRIORIDADES_DA_TAREFA).optional(),
  lead_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  /** As tarefas de UMA demanda — a seção "Tarefas desta demanda" do inbox. */
  demanda_id: z.string().uuid().optional(),
  due_from: z.string().datetime({ offset: true }).optional(),
  due_to: z.string().datetime({ offset: true }).optional(),
  /** "abertas" = o que ainda pede ação. É o default da tela. */
  aberto: z.enum(["true", "false"]).optional(),
  /**
   * De QUEM é a tarefa: `me` (o usuário da sessão, resolvido aqui), `ninguem`
   * (sem responsável) ou o id de um membro. Sem isto a tela de Tarefas misturava
   * a equipe inteira numa lista só (a lista corta em 500 — filtrar na tela
   * esconderia as que ficaram fora do corte). Um id de terceiro vindo do
   * navegador só ESTREITA uma lista que viewer+ já vê inteira; a organização sai
   * da sessão e a RLS segura o resto.
   */
  assigned_to: z.union([z.literal("me"), z.literal("ninguem"), z.string().uuid()]).optional(),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_tasks",
    role: "viewer",
    scope: "mcp:read",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const orgId = authz.organizationId;
  const usuario = usuarioDaSessao(authz);

  const parsed = listaSchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const filtros = parsed.data;
  if (filtros.assigned_to === "me" && !usuario) {
    return fail("validation_failed", t("Parâmetros inválidos."), 422, {
      requestId,
      details: { assigned_to: ["'me' só existe na sessão de navegador"] },
    });
  }

  const supabase = authz.supabase;

  // ⚠️ `organization_id` à mão SEMPRE: no ramo do token o cliente é o admin
  // (bypassa RLS) e este filtro é a única coisa que segura a organização. Na
  // sessão ele também é a regra do CLAUDE.md, não redundância. Consequência
  // aceita: o token enxerga todas as tarefas da org (é credencial de org); a
  // visibilidade por pessoa da RLS (`fn_can_view_task`) vale só para a sessão.
  let query = supabase
    .from("crm_tasks")
    .select(COLUNAS)
    .eq("organization_id", orgId)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500);

  if (filtros.status) query = query.eq("status", filtros.status);
  if (filtros.priority) query = query.eq("priority", filtros.priority);
  if (filtros.lead_id) query = query.eq("lead_id", filtros.lead_id);
  if (filtros.contact_id) query = query.eq("contact_id", filtros.contact_id);
  if (filtros.demanda_id) query = query.eq("demanda_id", filtros.demanda_id);
  if (filtros.due_from) query = query.gte("due_date", filtros.due_from);
  if (filtros.due_to) query = query.lte("due_date", filtros.due_to);
  if (filtros.aberto === "true") query = query.in("status", ["pending", "in_progress"]);
  if (filtros.assigned_to === "me") query = query.eq("assigned_to", usuario!);
  else if (filtros.assigned_to === "ninguem") query = query.is("assigned_to", null);
  else if (filtros.assigned_to) query = query.eq("assigned_to", filtros.assigned_to);

  const { data, error } = await query;
  if (error) {
    return fail("internal_error", t("Erro ao listar as tarefas."), 500, { requestId });
  }

  const encontradas = (data ?? []) as unknown as Tarefa[];
  // Filtro é aplicado à DEMANDA de trabalho, não pode amputar a família. Se
  // uma filha casa com "Minhas" ou "Em aberto", trazemos a raiz e todas as
  // irmãs; sem isso uma filha aberta sob raiz concluída desapareceria da tela.
  const idsPresentes = new Set(encontradas.map((tarefa) => tarefa.id));
  const paisAusentes = [
    ...new Set(
      encontradas
        .map((tarefa) => tarefa.parent_task_id)
        .filter((id): id is string => Boolean(id) && !idsPresentes.has(id!)),
    ),
  ];
  const { data: pais, error: erroPais } = paisAusentes.length
    ? await supabase
        .from("crm_tasks")
        .select(COLUNAS)
        .eq("organization_id", orgId)
        .in("id", paisAusentes)
    : { data: [], error: null };
  if (erroPais) return fail("internal_error", t("Erro ao listar as tarefas."), 500, { requestId });
  const raizes = [
    ...new Set([
      ...encontradas.filter((tarefa) => !tarefa.parent_task_id).map((tarefa) => tarefa.id),
      ...paisAusentes,
    ]),
  ];
  const { data: filhas, error: erroFilhas } = raizes.length
    ? await supabase
        .from("crm_tasks")
        .select(COLUNAS)
        .eq("organization_id", orgId)
        .in("parent_task_id", raizes)
    : { data: [], error: null };
  if (erroFilhas)
    return fail("internal_error", t("Erro ao listar as tarefas."), 500, { requestId });
  const porId = new Map(
    [
      ...encontradas,
      ...((pais ?? []) as unknown as Tarefa[]),
      ...((filhas ?? []) as unknown as Tarefa[]),
    ].map((tarefa) => [tarefa.id, tarefa]),
  );
  return ok({ tasks: [...porId.values()] }, { requestId });
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  // `agent` e não `manager`: criar tarefa é o gesto de quem ATENDE, todo dia.
  const authz = await resolveAuthDual(req, {
    requestId,
    resource: "crm_tasks",
    role: "agent",
    scope: "mcp:write",
  });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.idioma ?? "pt-BR");
  const orgId = authz.organizationId;
  const usuario = usuarioDaSessao(authz);

  const tetoEstourado = await tetoDeEscritaDoToken(authz, "tasks", requestId);
  if (tetoEstourado) return tetoEstourado;

  const parsed = criacaoSchema.safeParse(await req.json().catch(() => null));
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

  let contextoHerdado: {
    lead_id: string | null;
    contact_id: string | null;
    demanda_id: string | null;
  } | null = null;
  if (parsed.data.parent_task_id) {
    const { data: pai, error: erroPai } = await supabase
      .from("crm_tasks")
      .select("id, parent_task_id, lead_id, contact_id, demanda_id")
      .eq("id", parsed.data.parent_task_id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (erroPai) return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
    if (!pai)
      return fail("validation_failed", t("A tarefa principal não existe."), 422, { requestId });
    if ((pai as { parent_task_id?: string | null }).parent_task_id) {
      return fail("state_conflict", t("Uma subtarefa não pode ter subtarefas."), 409, {
        requestId,
      });
    }
    contextoHerdado = {
      lead_id: (pai.lead_id as string | null) ?? null,
      contact_id: (pai.contact_id as string | null) ?? null,
      demanda_id: (pai.demanda_id as string | null) ?? null,
    };
  }

  const vereditoDosVinculos = await conferirVinculosDaTarefa(
    supabase,
    orgId,
    contextoHerdado ?? parsed.data,
  );
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

  const demandaParaConferir = contextoHerdado?.demanda_id ?? parsed.data.demanda_id;
  if (demandaParaConferir) {
    // A chave estrangeira não passa pela RLS: sem esta conferência, a demanda
    // de outra organização gravaria sem erro. A régua está em `lib/tarefas/demanda.ts`.
    const veredito = await conferirDemanda(supabase, orgId, demandaParaConferir);
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

  const { tarefa, erro: error } = await gravarTarefa(supabase, {
    ...parsed.data,
    ...(contextoHerdado ?? {}),
    organization_id: orgId,
    created_by: usuario,
    recurrence_id: null,
    recurrence_generation: 0,
    recurrence_scheduled_for: null,
  });

  if (error) {
    // 23503 = negócio, contato ou demanda apagado no meio, entre a escolha e a
    // gravação. A recusa nomeia os campos porque quem lê é quem escolheu na tela.
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
    return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });
  }

  if (!tarefa) return fail("internal_error", t("Erro ao salvar a tarefa."), 500, { requestId });

  await audit({
    organizationId: orgId,
    actorUserId: usuario,
    actorApiTokenId: authz.apiTokenId ?? null,
    bypassedRls: authz.via === "token",
    action: "crm_task.created",
    resourceType: "crm_tasks",
    resourceId: tarefa.id,
    requestId,
    metadata: { due_date: tarefa.due_date, priority: tarefa.priority },
  });

  // O laço de retorno: tarefa presa a um negócio aparece na linha do tempo dele.
  await registraAtividadeDaTarefa(supabase, {
    organizationId: orgId,
    tarefa,
    tipo: "task_created",
    actor: authz.actor,
  });

  return ok({ task: tarefa }, { requestId, status: 201 });
}
