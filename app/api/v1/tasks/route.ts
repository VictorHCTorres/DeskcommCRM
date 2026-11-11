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
import {
  chaveExternaSchema,
  comSinalDeCapacidade,
  ehConflitoDaChave,
  escaparParaLike,
  MAXIMO_DE_CHAVES_NO_FILTRO,
} from "@/lib/tarefas/chave-externa";
import { buscarDonaDaChave } from "@/lib/tarefas/dona-da-chave";
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
  /**
   * A chave externa de idempotência (D9). Opcional; com espaço nas pontas, vazia, com
   * caractere de controle ou com mais de 200 caracteres é 422 — nunca aparada em silêncio.
   * A unicidade é do ÍNDICE do banco, não desta validação.
   */
  external_id: chaveExternaSchema.optional(),
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
  /**
   * D9 — casamento EXATO por chave externa: `?external_id=a&external_id=b`, até 100. Com este
   * filtro ou o de prefixo a resposta traz só as linhas que casaram, sem a expansão de família.
   */
  external_id: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(MAXIMO_DE_CHAVES_NO_FILTRO)
    .optional(),
  /** D9 — casamento por PREFIXO da chave (com `%`, `_` e `\` tratados como texto). */
  external_id_prefix: z.string().min(1).max(200).optional(),
});

/** O sinal de capacidade (contrato D9 §3) vai em toda resposta, inclusive nas recusas. */
export async function GET(req: NextRequest): Promise<Response> {
  return comSinalDeCapacidade(await listar(req));
}

export async function POST(req: NextRequest): Promise<Response> {
  return comSinalDeCapacidade(await criar(req));
}

/**
 * Os parâmetros da lista. O `Object.fromEntries` de antes leva o ÚLTIMO valor de cada nome
 * (comportamento da 1.101.0, mantido para os filtros antigos); `external_id` é o único que
 * lê todos, e `external_id_prefix` repetido vira lista para o zod recusar em vez de escolher um.
 */
function parametrosDaLista(url: string): Record<string, unknown> {
  const busca = new URL(url).searchParams;
  const parametros: Record<string, unknown> = Object.fromEntries(busca);
  if (busca.has("external_id")) parametros.external_id = busca.getAll("external_id");
  if (busca.getAll("external_id_prefix").length > 1) {
    parametros.external_id_prefix = busca.getAll("external_id_prefix");
  }
  return parametros;
}

async function listar(req: NextRequest): Promise<Response> {
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

  const parsed = listaSchema.safeParse(parametrosDaLista(req.url));
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
  // `count: "exact"` conta as linhas que casam com os filtros ANTES do `limit(500)` e na mesma
  // consulta (mesmo retrato do banco): `meta.total` é o que quem lê compara com o que recebeu.
  let query = supabase
    .from("crm_tasks")
    .select(COLUNAS, { count: "exact" })
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
  if (filtros.external_id) query = query.in("external_id", filtros.external_id);
  if (filtros.external_id_prefix) {
    query = query.like("external_id", `${escaparParaLike(filtros.external_id_prefix)}%`);
  }

  const { data, error, count } = await query;
  if (error) {
    return fail("internal_error", t("Erro ao listar as tarefas."), 500, { requestId });
  }
  // Sem o total exato a lista não diz se foi cortada: melhor recusar do que calar.
  if (typeof count !== "number") {
    return fail("internal_error", t("Erro ao listar as tarefas."), 500, { requestId });
  }

  const encontradas = (data ?? []) as unknown as Tarefa[];
  // Consulta por chave é consulta de ROBÔ: só as linhas que casaram, sem a família da tela.
  if (filtros.external_id || filtros.external_id_prefix) {
    return ok({ tasks: encontradas }, { requestId, meta: { total: count } });
  }
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
  return ok({ tasks: [...porId.values()] }, { requestId, meta: { total: count } });
}

async function criar(req: NextRequest): Promise<Response> {
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
    // D9: a unicidade é do ÍNDICE. Só o 23505 DESTE índice vira 409 — outro 23505 é erro nosso.
    // Nada foi gravado, então não há auditoria nem atividade a desfazer: ambas só rodam
    // depois do insert que deu certo, mais abaixo.
    if (parsed.data.external_id !== undefined && ehConflitoDaChave(error)) {
      const dona = await buscarDonaDaChave(supabase, orgId, parsed.data.external_id);
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
