/**
 * Uma RODADA de campanha: no máximo um envio por NÚMERO, e só se o ritmo
 * permitir.
 *
 * ═══ Por que um por número, e não um lote ═══
 *
 * O ritmo é o produto. Quem dispara 500 de uma vez queima o número, e número
 * queimado não volta em dias — volta em semanas de warm-up, com o cliente sem
 * canal. A rodada pergunta ao motor de pacing (o MESMO do agente, não um espelho)
 * se pode enviar AGORA, envia um, registra no `pacing_ledger`, e acabou. A
 * cadência real é a do cron × a do throttle, o que for mais lento.
 *
 * Um por NÚMERO e não um por instalação: duas conexões diferentes não disputam
 * ritmo entre si — o `pacing_ledger` é por `channel_session_id` —, e serializar
 * tudo faria a campanha de um cliente esperar a do outro.
 *
 * ═══ Por que o motor de pacing do AGENTE ═══
 *
 * `lib/automation/throttle.ts` espaça por um `Map` de módulo (não sobrevive a
 * restart nem a dois processos) e o cap diário dele lê `channel_session_warmup`,
 * tabela sem escritor — o ramo nunca dispara (medido; está escrito no cabeçalho
 * de lá). Campanha é exatamente o caso que estoura número: precisa do contador
 * real (`pacing_ledger`) e do mesmo lock por número que a cadeia de envio usa,
 * para campanha e agente não furarem o ritmo um do outro.
 *
 * ═══ Por que a rodada vazia não audita ═══
 *
 * Regra do `CLAUDE.md`: rodada de cron que não fez nada NÃO é mutação. Numa
 * instalação sem campanha rodando, auditar cada tique encheria o audit log — foi
 * o achado 17 do mapa de jornadas (95% do audit log de uma VPS era batida de
 * cron vazia).
 *
 * Nunca lança para o cron: uma campanha quebrada não pode derrubar a rodada.
 */
import { randomUUID } from "node:crypto";

import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { decidePacing, dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import { loadChannelKnobs, loadPacingState, recordSend } from "@/lib/agent-engine/pacing/store";
import { beginServiceAtOrigin } from "@/lib/atendimento/origem";
import { canalTemRiscoDeBanimento } from "@/lib/channels/capabilities";
import {
  codigoDaPlataforma,
  ehLimiteDeVelocidade,
  falhaDoEnvioInteiro,
  fraseDaFalha,
} from "@/lib/channels/erro-da-plataforma";
import { feriadosDoBrasilDoAno } from "@/lib/lgpd/holidays-br";
import { logger } from "@/lib/logger";
import { OrgNaoOperanteError, STATUS_OPERANTE, ehOperante, statusDaOrgEmbutida } from "@/lib/organizacao/operante";
import type { Message } from "@/lib/types/messaging";

import { baloesDaCampanha, enviarEmBaloes, pausaEntreBaloes } from "./baloes";
import {
  COLUNAS_DO_DESTINATARIO,
  ESTADOS_DE_QUEM_RECEBEU,
  aplicarVeto,
  conferenciaFinal,
  ehProspeccao,
  travaDaProspeccao,
  vetosDaPessoa,
  type DestinatarioRow,
} from "./conferencia";
import { statusDaSaida } from "./elegibilidade";
import { VetoDaCampanhaError, type VetoDaCampanha } from "./entrega";
import type { ConteudoDoEnvio } from "./modelo";
import { renderizar } from "./renderizador";
import { RAJADA, RajadaInterrompida, rodarEmRajada } from "./rajada";
import { escolherNumero, poolDaCampanha, type NumeroDisponivel } from "./rodizio";
import { podeMandarAgora, proximaTentativa, type RitmoDaCampanha } from "./ritmo";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { TEXTO_DA_EXCLUSAO } from "./tipos";

export interface ResultadoDaRodada {
  /** Mensagens que saíram de fato. */
  enviadas: number;
  /** Destinatários marcados como excluídos nesta rodada (veto revalidado). */
  pulados: number;
  /** Campanhas que terminaram. */
  concluidas: number;
  /** Campanhas agendadas que viraram `running` porque a hora chegou. */
  promovidas: number;
  detalhe: string;
}

const VAZIA: ResultadoDaRodada = {
  enviadas: 0,
  pulados: 0,
  concluidas: 0,
  promovidas: 0,
  detalhe: "nada_a_fazer",
};

/** Teto de números atendidos por rodada — a rodada é de um minuto, não de um dia. */
export const NUMEROS_POR_RODADA = 10;

/** Teto de agendadas promovidas por rodada: a sobra vira `running` no minuto seguinte. */
const PROMOVIDAS_POR_RODADA = 100;

interface CampanhaRow {
  id: string;
  organization_id: string;
  /** O número PRINCIPAL. O pool efetivo inclui os vinculados (migration 0377). */
  channel_session_id: string;
  name: string;
  message_body: string | null;
  content_version: number;
  intervalo_segundos: number | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
  teto_diario: number | null;
  teto_horario: number | null;
  /** Migration 0710: `template` = modelo aprovado pelo número oficial. */
  message_mode: string;
  provider_template_name: string | null;
  provider_template_language: string | null;
  /** Migration 0711: `rapida` = rajada na rodada (só com modelo); `gradual` = uma por rodada. */
  velocidade: string;
  /** Migration 0765: texto sai em balões, um por parágrafo. Modelo nunca se divide. */
  split_messages: boolean;
  started_at: string | null;
  paused_at: string | null;
  /** `legitimate_interest` = prospecção: abordagem fria, apoiada na avaliação de legítimo interesse (LIA). */
  base_legal: string | null;
  /** O instante da fotografia da audiência: o que mudou depois, a preparação não viu. */
  prepared_at: string | null;
  /** O filtro da audiência (`audiencia.ts`); a rodada só lê `sem_tags`, e só na prospecção. */
  audience_filter: unknown;
}

const COLUNAS_DA_CAMPANHA =
  "id, organization_id, channel_session_id, name, message_body, content_version, " +
  "intervalo_segundos, janela_inicio_hora, janela_fim_hora, teto_diario, teto_horario, " +
  "message_mode, provider_template_name, provider_template_language, velocidade, split_messages, started_at, paused_at, " +
  "base_legal, prepared_at, audience_filter";

/**
 * O status da organização embutido com `!inner` no `select`, e filtrado na
 * própria consulta (`organizations.status`): o corte sai no banco, ANTES do
 * `limit`. Filtrar só em memória deixaria a campanha da org parada ocupar a
 * janela — ela nunca conclui, e a ordem por `started_at` a mantém no topo. Nunca
 * se trafega a lista de ids das paradas numa `in (...)` da URL: ela cresce sem
 * teto e corta em `max_rows` sem aviso (issue #2015).
 */
const COLUNAS_DA_CAMPANHA_COM_EMBED = `${COLUNAS_DA_CAMPANHA}, organizations:organization_id!inner(status)`;

export async function rodarUmaRodadaDeCampanha(
  admin: SupabaseClient,
  agora: Date = new Date(),
): Promise<ResultadoDaRodada> {
  // Organização que não OPERA (suspensa, redigida ou arquivada) não dispara
  // campanha: disparo em massa custa ao dono da instalação e sai para fora. A
  // régua é a única do produto, `lib/organizacao/operante.ts`. O comentário que
  // morava aqui dizia que `= 'suspended'` era "a mesma decisão da fila do
  // agente"; a fila nunca filtrou status (o `CLAIM_SQL` de
  // `lib/agent-engine/queue/queue.ts` não olha `organizations`), e quem fecha a
  // fila é `fn_suspender_organizacao`, que falha os jobs pendentes.
  const promovidas = await promoverAgendadas(admin, agora);

  const { data: campanhas, error: falhaDaBusca } = await admin
    .from("campaigns")
    .select(COLUNAS_DA_CAMPANHA_COM_EMBED)
    .eq("status", "running")
    .eq("organizations.status", STATUS_OPERANTE)
    .order("started_at", { ascending: true })
    .limit(NUMEROS_POR_RODADA * 3);
  if (falhaDaBusca) {
    // Sem isto a falha virava "nada_a_fazer": indistinguível de rodada vazia.
    logger.warn("[campanha] busca das campanhas em andamento falhou", { motivo: falhaDaBusca.message });
    return { ...VAZIA, promovidas, detalhe: "busca_falhou" };
  }
  // `as unknown as`: a lista de colunas é montada por concatenação, e o tipo
  // gerado do PostgREST só sabe inferir literal — o mesmo caminho que
  // `lib/asaas/*` já usa para tabela que ainda não está em `database.types.ts`.
  // ponytail: o `ehOperante` aqui é cinto — o banco já cortou; ele só segura o
  // dia em que alguém tirar o filtro da consulta.
  const emExecucao = ((campanhas ?? []) as unknown as Array<
    CampanhaRow & { organizations?: { status?: string | null } | Array<{ status?: string | null }> | null }
  >).filter((campanha) => ehOperante(statusDaOrgEmbutida(campanha.organizations)));
  if (emExecucao.length === 0) {
    return promovidas > 0 ? { ...VAZIA, promovidas, detalhe: "promovidas" } : VAZIA;
  }

  // Dois conjuntos, e não um (#3112). `principaisOcupados` decide se a campanha
  // inteira espera a vez (regra do #3107, `ocupaONumero`); `numerosQueFalaram`
  // só tira o número do RODÍZIO das campanhas seguintes. Juntá-los pulava a
  // campanha cujo principal é o vinculado que outra usou, mesmo com outro número
  // dela livre — e ela ficava em zero até a outra terminar.
  const principaisOcupados = new Set<string>();
  const numerosQueFalaram = new Set<string>();
  const total: ResultadoDaRodada = { ...VAZIA, promovidas, detalhe: "" };
  const detalhes: string[] = [];
  const somarAoTotal = (r: { enviadas: number; pulados: number; concluidas: number }) => {
    total.enviadas += r.enviadas;
    total.pulados += r.pulados;
    total.concluidas += r.concluidas;
  };

  for (const campanha of emExecucao) {
    // Um número, uma mensagem por rodada. A campanha mais antiga do número ganha
    // a vez: sem isso, a última criada poderia monopolizar a fila para sempre.
    if (principaisOcupados.has(campanha.channel_session_id)) continue;
    // O teto conta os principais, não a união com `numerosQueFalaram`: toda
    // campanha que fala ocupa o principal dela (e eles são distintos), então
    // |numerosQueFalaram| <= |principaisOcupados|. A união contava 2 por campanha
    // que sai pelo vinculado e matava de fome a 6ª em diante.
    if (principaisOcupados.size >= NUMEROS_POR_RODADA) break;

    try {
      const r = emRajada(campanha)
        ? await rodarCampanhaEmRajada(admin, campanha, numerosQueFalaram)
        : await rodarUmaCampanha(admin, campanha, agora, numerosQueFalaram);
      somarAoTotal(r);
      detalhes.push(`${campanha.id.slice(0, 8)}:${r.detalhe}`);
      if (ocupaONumero(r)) principaisOcupados.add(campanha.channel_session_id);
      // O número que FALOU nesta rodada, que no rodízio pode não ser o principal
      // (#3112): sem isto, outra campanha que divide o vinculado mandava por ele
      // de novo no mesmo tique. A rajada fala em vários envios, e pode ter saído
      // por mais de um número: entram todos.
      for (const numero of numerosQueAFalaUsou(r)) numerosQueFalaram.add(numero);
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      // A rajada que parou por erro traz o que já tinha feito (F4k, K08 do cxj):
      // os envios entram na conta, e os números por onde ela falou ficam fora do
      // rodízio das campanhas seguintes desta rodada, como no desfecho normal.
      const parcial = err instanceof RajadaInterrompida ? err.parcial : null;
      logger.warn("[campanha] rodada falhou", {
        campanha: campanha.id,
        motivo,
        ...(parcial ? { parcial: parcial.detalhe } : {}),
      });
      detalhes.push(`${campanha.id.slice(0, 8)}:erro`);
      principaisOcupados.add(campanha.channel_session_id);
      if (parcial) {
        somarAoTotal(parcial);
        for (const numero of numerosQueAFalaUsou(parcial)) numerosQueFalaram.add(numero);
      }
    }
  }

  total.detalhe = detalhes.join(" ") || "nada_a_fazer";
  return total;
}

/**
 * `scheduled` cuja hora chegou vira `running` — só de org operante, em dois
 * passos limitados. O PostgREST filtra por recurso EMBUTIDO, e um `update` não
 * embute: `organizations.status` ali ou dá erro ou não corta nada. Por isso:
 * (a) escolhe os ids no banco, com o embed `!inner` e o corte antes do
 * `limit`; (b) promove só esses ids, e só se ainda estão `scheduled` (outra
 * rodada concorrente não promove duas vezes). A lista que vai na URL é a das
 * campanhas a promover, com teto — nunca a das orgs paradas, que não tem teto.
 */
async function promoverAgendadas(
  admin: SupabaseClient,
  agora: Date,
): Promise<number> {
  const { data: vencidas, error: falhaDaEscolha } = await admin
    .from("campaigns")
    .select("id, organizations:organization_id!inner(status)")
    .eq("status", "scheduled")
    .lte("scheduled_at", agora.toISOString())
    .eq("organizations.status", STATUS_OPERANTE)
    .order("scheduled_at", { ascending: true })
    .limit(PROMOVIDAS_POR_RODADA);
  if (falhaDaEscolha) {
    logger.warn("[campanha] promoção de agendadas falhou", { motivo: falhaDaEscolha.message });
    return 0;
  }
  const ids = ((vencidas ?? []) as Array<{ id: string }>).map((c) => c.id);
  if (ids.length === 0) return 0;
  const { data, error } = await admin
    .from("campaigns")
    .update({ status: "running", started_at: agora.toISOString() })
    .in("id", ids)
    .eq("status", "scheduled")
    .select("id");
  if (error) {
    logger.warn("[campanha] promoção de agendadas falhou", { motivo: error.message });
    return 0;
  }
  return (data ?? []).length;
}

/**
 * A campanha avaliada nesta rodada ocupa o número para as seguintes?
 *
 * Só ocupa quem usou o número (enviou, ou pulou um destinatário no caminho) ou
 * foi vetado pelo CANAL: a seguinte do mesmo número receberia o mesmo veto, e
 * ocupar economiza a consulta. NÃO ocupa quem parou pelo ritmo DELA (`ritmo:*`
 * — teto diário/horário, intervalo, janela da campanha), quem só está
 * esperando `next_attempt_at` (`aguardando`) nem quem concluiu: nesses casos o
 * número segue livre, e a campanha seguinte tem o próprio ritmo.
 *
 * Até a #3102 a regra era `concluidas === 0`, e o comentário já dizia isto:
 * a campanha mais antiga batia o teto do dia às 9h37 e a seguinte do mesmo
 * número não mandava nada até a primeira terminar — dias depois.
 */
export function ocupaONumero(r: { concluidas: number; detalhe: string }): boolean {
  if (r.concluidas > 0) return false;
  if (r.detalhe.startsWith("ritmo:")) return false;
  if (r.detalhe === "aguardando" || r.detalhe === "ja_concluida") return false;
  return true;
}

/** Por onde a campanha falou na rodada: o envio de sempre devolve um número; a rajada, todos os dela. */
function numerosQueAFalaUsou(r: { detalhe: string; numero?: string; numeros?: readonly string[] }): readonly string[] {
  return r.numeros ?? (r.numero ? [r.numero] : []);
}

/** Os próximos pendentes da campanha cuja vez chegou, na ordem da fila. */
async function pendentesDaCampanha(
  admin: SupabaseClient,
  campanhaId: string,
  agora: Date,
  quantos: number,
): Promise<DestinatarioRow[]> {
  const { data, error } = await admin
    .from("campaign_recipients")
    .select(COLUNAS_DO_DESTINATARIO)
    .eq("campaign_id", campanhaId)
    .eq("status", "pending")
    .or(`next_attempt_at.is.null,next_attempt_at.lte.${agora.toISOString()}`)
    .order("created_at", { ascending: true })
    .limit(quantos);
  // Sem conseguir ler a fila, ninguém sabe se ela acabou (F4j, J11 do cxj): lida
  // como vazia, a campanha era concluída com gente pendente, e a vigia deixava de
  // vê-la. A exceção sobe ao laço da rodada, que registra e segue com a campanha
  // em andamento; a rajada para no mesmo laço.
  if (error) throw new Error(`a fila da campanha não foi lida: ${error.message}`);
  return (data ?? []) as unknown as DestinatarioRow[];
}

/** Velocidade rápida só com modelo: o CHECK da 0711 garante, e o despacho confere de novo. */
function emRajada(campanha: CampanhaRow): boolean {
  return campanha.velocidade === "rapida" && campanha.message_mode === "template";
}

/** O resultado da rodada para um veto já aplicado ao destinatário: só o `pular` conta como pulado. */
function desfechoDoVeto(
  veto: VetoDaCampanha,
  detalhe: string,
): { enviadas: 0; pulados: 0 | 1; concluidas: 0; detalhe: string } {
  return { enviadas: 0, pulados: "pular" in veto ? 1 : 0, concluidas: 0, detalhe };
}

/** O dia de `agora`, no fuso dado, é um dos feriados nacionais de `lib/lgpd/holidays-br.ts`? */
function ehFeriadoNacional(agora: Date, fuso: string): boolean {
  const dia = new Intl.DateTimeFormat("sv-SE", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
  return feriadosDoBrasilDoAno(Number(dia.slice(0, 4))).includes(dia);
}

/** A meia-noite LOCAL seguinte: 36 h depois da de hoje cai sempre no dia seguinte, com ou sem horário de verão. */
function meiaNoiteSeguinte(agora: Date, fuso: string): Date {
  return dayStartInTz(new Date(dayStartInTz(agora, fuso).getTime() + 36 * 3_600_000), fuso);
}

/**
 * A rodada de uma campanha RÁPIDA: o envio de sempre, repetido em rajada no
 * prazo da rodada. As regras (ritmo, lotes, quando parar) estão em `rajada.ts`.
 *
 * `numerosJaUsados` são os números por onde OUTRAS campanhas já falaram nesta
 * rodada (#3112): saem do rodízio de cada envio da rajada. Os que a própria
 * rajada usa não entram ali durante ela — senão ela parava no segundo envio —, e
 * voltam no desfecho (`numeros`), para as campanhas seguintes da rodada.
 */
async function rodarCampanhaEmRajada(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  numerosJaUsados: ReadonlySet<string>,
): Promise<{ enviadas: number; pulados: number; concluidas: number; detalhe: string; numeros: string[] }> {
  return rodarEmRajada<DestinatarioRow>(
    {
      buscarLote: (quantos) => pendentesDaCampanha(admin, campanha.id, new Date(), quantos),
      enviarUm: (alvo) => rodarUmaCampanha(admin, campanha, new Date(), numerosJaUsados, alvo),
      aindaEmAndamento: async () => {
        const { data, error } = await admin.from("campaigns").select("status").eq("id", campanha.id).maybeSingle();
        // Sem ler, ninguém sabe se a campanha parou (F4l, L01 do cxj): o erro lido
        // como “parou” encerrava a rajada calado, e a campanha seguia `running` sem
        // aviso. Lança, e a rodada registra o erro com o que a rajada já tinha feito.
        if (error) throw new Error(`o andamento da campanha não foi lido: ${error.message}`);
        return (data as { status?: string } | null)?.status === "running";
      },
      concluirSeAcabou: () => rodarUmaCampanha(admin, campanha, new Date(), numerosJaUsados),
      agora: () => Date.now(),
      esperar: (ms) => new Promise((ok) => setTimeout(ok, ms)),
    },
    RAJADA,
  );
}

async function rodarUmaCampanha(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  agora: Date,
  numerosJaUsados: ReadonlySet<string>,
  /** A rajada escolhe o destinatário do lote; sem ele, o primeiro da fila. */
  escolhido?: DestinatarioRow,
): Promise<{ enviadas: number; pulados: number; concluidas: number; detalhe: string; numero?: string }> {
  // Campanha com modelo: uma falha que vale para o ENVIO INTEIRO (modelo
  // pausado, número restringido, pagamento) chega pelo webhook, depois do envio.
  // Cada envio seguinte seria a mesma falha, e o número perde qualidade a cada
  // uma — a campanha para aqui, com o motivo, antes do próximo.
  if (campanha.message_mode === "template") {
    const parada = await falhaQueParaACampanha(admin, campanha);
    if (parada) {
      await pausarPorFalha(admin, campanha.id, parada, agora);
      return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `pausada:${parada.codigo}` };
    }
  }

  const alvo = escolhido ?? (await pendentesDaCampanha(admin, campanha.id, agora, 1))[0];

  if (!alvo) {
    // Nada pendente AGORA não é o mesmo que nada pendente: pode haver gente
    // esperando `next_attempt_at`. Só conclui quem não tem mais nenhum em voo.
    const { count, error } = await admin
      .from("campaign_recipients")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campanha.id)
      .in("status", ["pending", "queued", "sending"]);
    // Só a contagem LIDA conclui: o erro, ou a contagem que não veio, não é zero (F4j, J11).
    if (error || typeof count !== "number") {
      throw new Error(`a contagem da fila da campanha não foi lida: ${error?.message ?? "sem contagem"}`);
    }
    if (count > 0) return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "aguardando" };

    const { data } = await admin
      .from("campaigns")
      .update({ status: "completed", completed_at: agora.toISOString() })
      .eq("id", campanha.id)
      .eq("status", "running")
      .select("id");
    return {
      enviadas: 0,
      pulados: 0,
      concluidas: (data ?? []).length,
      detalhe: (data ?? []).length > 0 ? "concluida" : "ja_concluida",
    };
  }

  // ─── Os vetos por PESSOA, revalidados ───
  // Vêm ANTES do ritmo de propósito: pular não gasta janela de envio, e uma fila
  // cheia de bloqueados não pode consumir o teto diário do número. E são
  // revalidados porque entre a preparação e agora a pessoa pode ter pedido para
  // parar — honrar o pedido com um dia de atraso é o mesmo que não honrar.
  // A lista de exclusão da operação entra aqui também, e não só na preparação:
  // ela pode ter crescido depois do snapshot, e o ponto dela é impedir o envio.
  // Sem conseguir lê-la, não manda agora (F4g, A2): o erro era lido como "não
  // está na lista".
  const contato = alvo.contacts;
  const daPessoa = await vetosDaPessoa(admin, campanha, alvo);
  if (daPessoa && "esperar" in daPessoa) {
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `trava:${daPessoa.esperar}` };
  }
  if (daPessoa) {
    const motivo = daPessoa.pular;
    await admin
      .from("campaign_recipients")
      .update({
        status: statusDaSaida(motivo),
        eligibility_status: "excluded",
        exclusion_reason: motivo,
        opted_out_at: motivo === "opt_out" ? agora.toISOString() : null,
      })
      .eq("id", alvo.id)
      .eq("status", "pending");
    return { enviadas: 0, pulados: 1, concluidas: 0, detalhe: `pulado:${motivo}` };
  }

  // ─── A fotografia da PROSPECÇÃO, revalidada (ver `travaDaProspeccao`) ───
  if (ehProspeccao(campanha)) {
    const trava = await travaDaProspeccao(admin, campanha, alvo, agora);
    if (trava && "esperar" in trava) {
      // Sem a leitura (ou sem o corte) não há como saber se a pessoa respondeu:
      // não manda agora, e o destinatário fica pendente para o próximo tique.
      return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `trava:${trava.esperar}` };
    }
    if (trava) {
      await admin
        .from("campaign_recipients")
        .update({ status: "skipped", eligibility_status: "excluded", exclusion_reason: trava.pular })
        .eq("id", alvo.id)
        .eq("status", "pending");
      return { enviadas: 0, pulados: 1, concluidas: 0, detalhe: `pulado:${trava.pular}` };
    }
  }

  // ─── O ritmo da CAMPANHA, que vale para ela inteira ───
  //
  // Antes do rodízio de propósito: o intervalo e o teto da campanha somam TODOS
  // os números dela. Quem quer que o rodízio aumente o volume deixa o ritmo da
  // campanha em branco e herda o de cada número; quem põe 60s aqui manda uma a
  // cada 60s no total, com um número ou com cinco.
  const pool = getRequestPool();
  const ritmo: RitmoDaCampanha = {
    // Na rápida o intervalo não vale: a rajada tem o próprio espaçamento, e um
    // intervalo de campanha a reduziria a uma mensagem por rodada.
    intervaloSegundos: emRajada(campanha) ? null : campanha.intervalo_segundos,
    janelaInicioHora: campanha.janela_inicio_hora,
    janelaFimHora: campanha.janela_fim_hora,
    tetoDiario: campanha.teto_diario,
    tetoHorario: campanha.teto_horario,
  };
  const numeros = await numerosDaCampanha(admin, campanha);
  // O fuso da janela da campanha é o do número PRINCIPAL: ela é uma decisão da
  // campanha, e precisa de um relógio só — três números em fusos diferentes
  // fariam a mesma campanha abrir e fechar a janela três vezes.
  const knobsDoPrincipal = await loadChannelKnobs(pool, campanha.organization_id, campanha.channel_session_id);
  // Prospecção não sai em feriado nacional. O motor sabe os DIAS da semana do
  // número (`prospeccaoDias`, logo abaixo), não o calendário: a sobra de quinta
  // saía no feriado de sexta, na abertura da janela. Espera, não exclui: o
  // destinatário volta à fila à meia-noite seguinte, no fuso do principal. É
  // `ritmo:` para não ocupar o número — a campanha de consentimento segue.
  if (ehProspeccao(campanha) && ehFeriadoNacional(agora, knobsDoPrincipal.knobs.timezone)) {
    await admin
      .from("campaign_recipients")
      .update({ next_attempt_at: meiaNoiteSeguinte(agora, knobsDoPrincipal.knobs.timezone).toISOString() })
      .eq("id", alvo.id)
      .eq("status", "pending");
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "ritmo:feriado" };
  }
  // ⚠️ O estado do ritmo é lido DEPOIS dos knobs porque precisa do MESMO fuso
  // que a janela usa. Com `setUTCHours`, o "dia" virava 21h no horário de
  // Brasília — DENTRO da janela de envio —, e uma campanha que já tinha batido
  // o teto diário voltava a enviar com uma hora de janela pela frente.
  // Sem intervalo nem teto, o estado não decide nada — e na rajada lê-lo seria
  // reler todos os enviados do dia a cada mensagem.
  const usaEstado = ritmo.intervaloSegundos !== null || ritmo.tetoDiario !== null || ritmo.tetoHorario !== null;
  const estado = usaEstado
    ? await estadoDeEnvio(admin, campanha.id, agora, knobsDoPrincipal.knobs.timezone)
    : { ultimoEnvio: null, enviadasHoje: 0, enviadasNaUltimaHora: 0 };
  const doRitmo = podeMandarAgora(ritmo, estado, agora, knobsDoPrincipal.knobs.timezone);
  if (!doRitmo.pode) {
    // Espera não é falha: grava QUANDO tentar de novo para a fila não ser varrida
    // a cada tique por uma campanha que só volta amanhã.
    const proxima = proximaTentativa(doRitmo, agora);
    if (proxima) {
      await admin
        .from("campaign_recipients")
        .update({ next_attempt_at: proxima.toISOString() })
        .eq("id", alvo.id)
        .eq("status", "pending");
    }
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `ritmo:${doRitmo.motivo}` };
  }

  // Quantos balões esta pessoa vai receber, medido no texto congelado (a
  // saudação do render não cria parágrafo). O teto do número é conferido para
  // TODOS eles antes de começar: parar no meio por teto entregaria meia mensagem.
  const comModelo = campanha.message_mode === "template";
  const dividir = !comModelo && campanha.split_messages === true;
  const congelado = alvo.rendered_body ?? campanha.message_body ?? "";
  const baloesPrevistos = baloesDaCampanha(congelado, dividir).length;

  // ─── O RODÍZIO: qual número fala com esta pessoa ───
  const disponiveis: NumeroDisponivel[] = [];
  const knobsPorNumero = new Map<string, Awaited<ReturnType<typeof loadChannelKnobs>>>();
  for (const sessionId of numeros) {
    const k =
      sessionId === campanha.channel_session_id
        ? knobsDoPrincipal
        : await loadChannelKnobs(pool, campanha.organization_id, sessionId);
    knobsPorNumero.set(sessionId, k);

    const { data: canal } = await admin
      .from("channel_sessions")
      .select("daily_message_limit, status, provider")
      .eq("organization_id", campanha.organization_id)
      .eq("id", sessionId)
      .maybeSingle();
    const linha = canal as { daily_message_limit: number | null; status: string; provider: string | null } | null;
    // Número fora do ar não entra no rodízio: mandar por ele seria fabricar uma
    // mensagem presa em `sending` que o recovery depois marca como falha.
    if (!linha || linha.status !== "WORKING") continue;

    const estadoDoNumero = await loadPacingState(pool, campanha.organization_id, sessionId, {
      now: agora,
      timezone: k.knobs.timezone,
      numberActivatedAt: k.numberActivatedAt,
    });
    const decisao = decidePacing({
      now: agora,
      knobs: k.knobs,
      // O último balão tem de caber no teto: conferir como se os anteriores já
      // tivessem saído. Com um balão só, é o estado de sempre.
      state: { ...estadoDoNumero, sentToday: estadoDoNumero.sentToday + baloesPrevistos - 1 },
      crmDailyLimit: linha.daily_message_limit ?? null,
      // Aquecimento e teto anti-ban são do número por QR. O oficial não é banido
      // por volume — quem limita ali é a plataforma (nível de mensagens) —, e o
      // ritmo próprio da campanha (intervalo, janela, tetos) continua valendo.
      banRisk: canalTemRiscoDeBanimento(linha.provider),
      // Prospecção lê os dias próprios do número (`prospeccaoDias`, 0642), como
      // o worker de prospecção já faz. Sem isto a campanha fria saía no sábado.
      prospeccao: ehProspeccao(campanha),
    });
    disponiveis.push({
      sessionId,
      folgaDoDia:
        linha.daily_message_limit === null
          ? null
          : Math.max(0, linha.daily_message_limit - estadoDoNumero.sentToday),
      // `allow` com `waitMs > 0` é "ainda não": falta o intervalo do número.
      // A rodada não espera dentro do tique (o `before-send` do agente espera;
      // a prospecção reagenda) — o número fica de fora e volta no próximo. E o
      // número que já falou nesta rodada, por outra campanha, também (#3112).
      podeAgora: decisao.allow && decisao.waitMs === 0 && !numerosJaUsados.has(sessionId),
      ultimoEnvio: estadoDoNumero.lastSentAt,
    });
  }

  const escolha = escolherNumero(disponiveis, await numeroDoHistorico(admin, campanha, alvo.contact_id));
  if (!escolha) {
    // Nenhum número pode agora. Não é falha do destinatário: é o ritmo dos
    // números. Volta para a fila e tenta no próximo tique.
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "canal:sem_numero_livre" };
  }
  const sessionEscolhida = escolha.sessionId;
  const knobs = knobsPorNumero.get(sessionEscolhida)!.knobs;

  // ─── O envio ───
  // O id da mensagem nasce AQUI, e não do insert: com ele, o destinatário já
  // aponta para a mensagem antes de ela existir, e o trigger de ack sempre
  // encontra a linha. É também a chave de idempotência do `sendMessageHandler` —
  // uma repetição depois de queda relê a linha em vez de mandar de novo.
  const messageId = randomUUID();
  const reserva = await reservarDestinatario(admin, alvo.id, agora);
  if (!reserva.reservado) {
    return {
      enviadas: 0,
      pulados: 0,
      concluidas: 0,
      detalhe: reserva.erro
        ? `erro_na_reserva:${reserva.erro.slice(0, 40)}`
        : reserva.parou
          ? "campanha_parou"
          : "ja_reservado",
    };
  }
  // ─── A conferência final (prospecção), relida do banco depois da reserva ───
  // A 1ª conferência roda antes do ritmo e do rodízio, e na rajada sobre o lote
  // buscado segundos antes: o que chegar nesse meio-tempo passava. Depois da
  // reserva nenhuma outra rodada pega a pessoa. Roda de novo logo antes do 1º
  // balão, no handler e antes de cada balão seguinte (`conferencia.ts`).
  const entrega = { organizationId: campanha.organization_id, campaignId: campanha.id, recipientId: alvo.id };
  const conferirAntesDoEnvio = async () => {
    if (!ehProspeccao(campanha)) return null;
    const veto = await conferenciaFinal(admin, entrega, agora, ["sending"]);
    return veto ? desfechoDoVeto(veto, await aplicarVeto(admin, alvo.id, veto, agora)) : null;
  };
  const depoisDaReserva = await conferirAntesDoEnvio();
  if (depoisDaReserva) return depoisDaReserva;

  // O corpo é montado DEPOIS do ritmo: a saudação ("bom dia" × "boa tarde") tem
  // de ser a do instante em que a mensagem SAI, no fuso do canal. Montá-la na
  // preparação produziria "bom dia" numa mensagem enviada à tarde — foi o
  // defeito do primeiro piloto.
  //
  // Com modelo não há saudação: o texto é o do modelo aprovado com os valores
  // congelados na preparação, e é ele que fica na conversa para o agente ler.
  const valoresDoModelo = comModelo ? valoresCongelados(alvo.variables) : null;
  if (comModelo && valoresDoModelo === null) {
    await admin
      .from("campaign_recipients")
      .update({ status: "failed", last_error_code: "modelo_sem_valores", sending_at: null })
      .eq("id", alvo.id)
      .eq("status", "sending");
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "falha:modelo_sem_valores" };
  }
  const corpo = comModelo
    ? congelado
    : renderizar(congelado, { nome: nomeDoContato(contato) }, { agora, fuso: knobs.timezone }).texto;
  const conteudo: ConteudoDoEnvio = comModelo
    ? {
        type: "template",
        template_name: campanha.provider_template_name ?? "",
        template_language: campanha.provider_template_language ?? "",
        template_values: valoresDoModelo ?? {},
        body: corpo,
      }
    : { type: "text", body: corpo };

  try {
    const boundary = await beginServiceAtOrigin(
      admin,
      campanha.organization_id,
      alvo.contact_id,
      sessionEscolhida,
    );
    await admin
      .from("campaign_recipients")
      .update({ conversation_id: boundary.conversation_id, channel_session_id: sessionEscolhida })
      .eq("id", alvo.id);
    // Abrir a conversa leva tempo, e a resposta, o comando humano ou o
    // cancelamento que chegarem nesse meio-tempo passavam (F4g, A3).
    const antesDoPrimeiroBalao = await conferirAntesDoEnvio();
    if (antesDoPrimeiroBalao) return antesDoPrimeiroBalao;

    // O 1º balão leva as chaves de sempre (id da mensagem, requestId,
    // idempotência): com a divisão desligada o envio é byte a byte o de antes.
    // Os seguintes ganham o índice nas chaves, para uma repetição não os fundir.
    // `maxBaloes = baloesPrevistos`: o teto foi conferido para esse número.
    const baloes = comModelo ? [corpo] : baloesDaCampanha(corpo, dividir, baloesPrevistos);
    const relogioDosBaloes = Date.now();
    // O registro no ledger que o banco recusou depois de o balão sair (F4l, L03/L06
    // do cxj). Uma lista, e não um `let`: preenchida só dentro do `registrar`, o
    // compilador a daria como sempre vazia aqui fora.
    const registrosRecusados: unknown[] = [];
    // O tipo vai explícito: com o `registrar` e o `parar` lendo o desfecho, o
    // compilador não o tira mais do retorno do `enviar`.
    const { primeira, desfecho: mensagem, indiceDoDesfecho } = await enviarEmBaloes<Message>(baloes, {
      enviar: async (texto, i) => {
        try {
          return await sendMessageHandler(
            admin,
            {
              organization_id: campanha.organization_id,
              serviceBoundary: boundary,
              proactiveContext: { organizationId: campanha.organization_id, contactId: alvo.contact_id },
              actor: { type: "webhook_source", id: `campaign:${campanha.id}` },
              requestId: i === 0 ? `campaign:${campanha.id}:${alvo.id}` : `campaign:${campanha.id}:${alvo.id}:${i}`,
              internalMessageId: i === 0 ? messageId : randomUUID(),
              // Na prospecção, TODO balão leva a entrega (F4i, I01): a conferência
              // final dentro do handler e o destino congelado na preparação (F4g,
              // A5). O 1º segue byte a byte o de antes (só o destinatário
              // reservado); os seguintes aceitam o que o ack do 1º já avançou.
              ...(ehProspeccao(campanha)
                ? {
                    campaignDelivery: {
                      ...entrega,
                      destinoAprovado: (alvo.recipient_address ?? "").trim(),
                      ...(i > 0 ? { estadosAceitos: ESTADOS_DE_QUEM_RECEBEU } : {}),
                    },
                  }
                : {}),
            } as Parameters<typeof sendMessageHandler>[1],
            {
              conversation_id: boundary.conversation_id,
              ...conteudo,
              ...(conteudo.type === "text" ? { body: texto } : {}),
              metadata: {
                source: "campaign",
                campaign_id: campanha.id,
                campaign_recipient_id: alvo.id,
                campaign_content_version: campanha.content_version,
                idempotency_key: i === 0 ? `campaign:${alvo.id}` : `campaign:${alvo.id}:${i}`,
              },
            } as Parameters<typeof sendMessageHandler>[2],
          );
        } catch (err) {
          // O handler vetou um balão SEGUINTE: o começo já saiu e não volta, e o
          // resto não vai — o mesmo desfecho do `continuar` falso. Aplicar o
          // veto aqui devolveria a pessoa à fila, e a rodada seguinte repetiria
          // o começo. O veto do 1º balão segue para o `catch` de fora.
          if (i > 0 && err instanceof VetoDaCampanhaError) return null;
          throw err;
        }
      },
      // Cada balão entra no ledger no instante em que SAIU: o throttle do próximo
      // envio do número conta a partir do último registro, e gravar todos com o
      // `agora` da rodada deixava o destinatário seguinte sair a menos de
      // `throttleMs` do último balão (medido na prova de tela: 941 ms). O 1º
      // balão segue com `agora`, como o envio único de antes.
      // A mensagem da prospecção que o canal segurou com certeza (o handler não
      // chamou o provedor) não entra: ela não sai nunca (F4i, A1), e contá-la
      // gastava o teto do dia do número com uma tentativa que não falou com
      // ninguém (F4j, J05/J09 do cxj). A incerta entra: pode ter saído.
      // O registro recusado não sobe mais como exceção (F4l, L03/L06 do cxj): ela
      // dava o envio que saiu como falha (`send_exception`), sem contá-lo, e a
      // campanha seguia sem o teto do dia ver a mensagem — com 59 de 60, saíam
      // mais três em três rodadas. Fica guardado, e a campanha pausa abaixo.
      registrar: async (i, desfecho) => {
        if (ehProspeccao(campanha) && retidaPeloCanal(desfecho)) return;
        try {
          await recordSend(
            pool,
            campanha.organization_id,
            sessionEscolhida,
            i === 0 ? agora : new Date(agora.getTime() + (Date.now() - relogioDosBaloes)),
          );
        } catch (err) {
          registrosRecusados.push(err);
        }
      },
      // Pausa curta e fixa no ritmo anti-ban do número, nunca o intervalo da
      // campanha: este laço é dividido por todas as campanhas da instalação.
      esperar: () => new Promise((ok) => setTimeout(ok, pausaEntreBaloes(knobs))),
      // Na prospecção, os balões seguintes passam pela conferência final
      // inteira (F4g, A4): quem respondeu, foi para atendimento humano, recusou
      // marketing, entrou na lista de exclusão ou teve a campanha cancelada
      // depois do 1º balão não recebe o resto; sem conseguir ler, também não
      // (o começo já saiu, e o resto espera a pessoa).
      ...(ehProspeccao(campanha)
        ? {
            continuar: async () => (await conferenciaFinal(admin, entrega, agora, ESTADOS_DE_QUEM_RECEBEU)) === null,
          }
        : {}),
      // Na prospecção, o balão que não saiu para os seguintes: o que o canal
      // segurou na fila física (F4i, A1), porque se o canal voltasse na pausa o
      // próximo sairia sem ele; e o incerto (`queued` sem o motivo), porque o
      // seguinte que saísse viraria o desfecho e esconderia a incerteza (F4j, J04
      // do cxj). Em toda campanha, o que não entrou no teto do número (F4l): cada
      // balão seguinte seria mais uma saída fora da conta do dia.
      parar: (desfecho) =>
        registrosRecusados.length > 0 || (ehProspeccao(campanha) && !SAIU.has(desfecho.status ?? "")),
    });

    // O ledger recusou o registro (F4l, L03/L06 do cxj): a campanha pausa antes de
    // qualquer desfecho — inclusive o da fila do canal e o do limite —, junto com
    // as outras do mesmo número, e nada sai delas até alguém conferir o número e
    // retomar. O desfecho segue como sempre: o envio que saiu conta, e o
    // destinatário fica `sent`.
    if (registrosRecusados.length > 0) {
      const [recusa] = registrosRecusados;
      logger.error("[campanha] o envio não entrou no teto do número; a campanha pausou", {
        campanha: campanha.id,
        destinatario: alvo.id,
        numero: sessionEscolhida,
        motivo: recusa instanceof Error ? recusa.message : String(recusa),
      });
      await pausarPeloTetoSemRegistro(admin, campanha, sessionEscolhida, agora);
    }

    // O desfecho vem do ESTADO da mensagem, nunca da ausência de exceção — o
    // handler marca `failed` e devolve normalmente. Com balões, o desfecho é o
    // do primeiro que falhou (ou o do último, se todos saíram).
    const status = mensagem.status;
    const falhou = status === "failed";
    const erro = mensagem;
    const codigoDaFalha = falhou ? codigoDaPlataforma(erro.error_code, erro.error_message) : null;

    // A mensagem de PROSPECÇÃO que não saiu (a fila física do canal) nunca conta
    // como enviada, nem fica na fila física (F4i, A1): o resgate do watchdog a
    // mandaria depois sem conferir a pessoa, e a vigia deixaria de acompanhar
    // quem já constasse como enviado.
    if (ehProspeccao(campanha) && !falhou && !SAIU.has(status ?? "")) {
      return desfechoDaFilaDoCanal(admin, {
        organizationId: campanha.organization_id,
        destinatarioId: alvo.id,
        retida: mensagem,
        primeiraId: primeira.id ?? messageId,
        indiceDoDesfecho,
        agora,
        numero: sessionEscolhida,
      });
    }

    // O provedor ou a plataforma pediram para DESACELERAR (429 do parceiro,
    // 130429 da plataforma). A mensagem não saiu e não tem nada de errado: o
    // destinatário volta para a fila e sai na próxima rodada. Falhá-lo tiraria
    // a pessoa da campanha por pressa nossa — o risco que a rajada cria.
    // Só no 1º balão: se um balão seguinte foi o barrado, a pessoa já recebeu o
    // começo, e voltar à fila reenviaria esse começo.
    if (falhou && indiceDoDesfecho === 0 && ehLimiteDeVelocidade(codigoDaFalha, erro.error_message)) {
      await admin
        .from("campaign_recipients")
        .update({
          status: "pending",
          sending_at: null,
          next_attempt_at: new Date(agora.getTime() + 60_000).toISOString(),
          last_error_code: "limite_de_velocidade",
          last_error_detail: (erro.error_message ?? "").slice(0, 300) || null,
        })
        .eq("id", alvo.id)
        .eq("status", "sending");
      return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `limite:${codigoDaFalha ?? "429"}` };
    }
    // `.eq("status","sending")` porque o ack pode ter chegado ANTES desta linha:
    // o trigger já teria avançado o destinatário para `sent`/`delivered`, e
    // escrever por cima o rebaixaria.
    await admin
      .from("campaign_recipients")
      .update({
        status: falhou ? "failed" : "sent",
        sent_at: falhou ? null : agora.toISOString(),
        // O código da PLATAFORMA quando há (131050, 132015…): é ele que a tela
        // traduz em motivo e que decide se a campanha para.
        last_error_code: falhou ? (codigoDaFalha ?? "send_failed") : null,
        last_error_detail: falhou ? (erro.error_message ?? null) : null,
        // O `message_id` só pode ser gravado AQUI: a coluna tem FK para
        // `messages`, e a linha da mensagem só existe depois do envio. Gravá-lo
        // antes — que era o desenho original, para o trigger de ack sempre achar
        // o destinatário — viola a FK e a reserva falha inteira.
        message_id: primeira.id ?? messageId,
      })
      .eq("id", alvo.id)
      .eq("status", "sending");

    if (falhou && falhaDoEnvioInteiro(codigoDaFalha)) {
      await pausarPorFalha(
        admin,
        campanha.id,
        { codigo: codigoDaFalha!, detalhe: fraseDaFalha(codigoDaFalha, erro.error_message) },
        agora,
      );
      return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `pausada:${codigoDaFalha}` };
    }

    return {
      enviadas: falhou ? 0 : 1,
      pulados: 0,
      concluidas: 0,
      // A pausa do teto sem registro aparece na rodada e para a rajada (`pausada:`).
      detalhe:
        registrosRecusados.length > 0
          ? `pausada:${TETO_SEM_REGISTRO.codigo}`
          : `enviado:${status ?? "?"}:${escolha.motivo}`,
      numero: sessionEscolhida,
    };
  } catch (err) {
    logger.warn("[campanha] envio falhou", { campanha: campanha.id, destinatario: alvo.id });
    // A exceção pode ter vindo depois de a mensagem sair: o número conta como usado.
    // O veto da PESSOA no handler (F4g, A3) tira o destinatário da fila: conta
    // como pulado, como nas conferências da rodada.
    return {
      enviadas: 0,
      pulados: err instanceof VetoDaCampanhaError && "pular" in err.veto ? 1 : 0,
      concluidas: 0,
      detalhe: await registrarExcecaoDoEnvio(admin, alvo.id, err, agora),
      numero: sessionEscolhida,
    };
  }
}

/** O que já saiu para o cliente: o canal aceitou (`sent`) ou confirmou (`delivered`/`read`). */
const SAIU = new Set(["sent", "delivered", "read"]);

/**
 * O canal segurou a mensagem na fila física, e o handler disse por quê
 * (`metadata.queued_reason`): o canal fora do ar ou ainda sem credencial. Nos
 * dois ramos o handler não chega a falar com o provedor — nada saiu.
 */
export function retidaPeloCanal(m: { status?: string | null; metadata?: unknown }): boolean {
  const motivo = (m.metadata as { queued_reason?: unknown } | null | undefined)?.queued_reason;
  return m.status === "queued" && typeof motivo === "string" && motivo !== "";
}

/**
 * A mensagem de prospecção que voltou do handler sem ter saído (F4i, A1).
 *
 * 1. Sai da fila física (`failed/campanha_sem_reenvio`), só se ainda estiver
 *    lá: quem manda a prospecção é a rodada, que confere a pessoa de novo; o
 *    resgate do watchdog não confere (e também a recusa, em
 *    `session-reconciler.ts`).
 * 2. O destinatário volta à fila da campanha SÓ quando nada saiu com certeza: o
 *    1º balão, retido com o motivo gravado pelo handler. Sem o motivo, o handler
 *    pode ter mandado e só não ter conseguido marcar `sent` — voltar à fila
 *    repetiria a mensagem; num balão seguinte, o começo já saiu. Nos dois casos
 *    o destinatário fica `failed`, e ninguém recebe de novo. O código diz a
 *    certeza: `canal_indisponivel` quando o canal segurou, `envio_incerto`
 *    quando pode ter saído.
 * 3. Escrita recusada pelo banco não passa por desfecho normal (F4j, J06 do cxj):
 *    a da mensagem fica no log (ela segue `queued`, e o resgate não manda
 *    prospecção); a do destinatário fica no log e no desfecho
 *    (`fila:sem_registro`). Ele segue reservado (`sending`): nenhuma rodada o
 *    pega de novo, e nada sai — o mesmo do veto sem registro (`aplicarVeto`).
 */
async function desfechoDaFilaDoCanal(
  admin: SupabaseClient,
  d: {
    organizationId: string;
    destinatarioId: string;
    retida: { id?: string | null; status?: string | null; metadata?: unknown };
    primeiraId: string;
    indiceDoDesfecho: number;
    agora: Date;
    numero: string;
  },
): Promise<{ enviadas: number; pulados: number; concluidas: number; detalhe: string; numero?: string }> {
  if (d.retida.id) {
    const { error } = await admin
      .from("messages")
      .update({
        status: "failed",
        error_code: "campanha_sem_reenvio",
        error_message: "Não saiu: a campanha de prospecção só manda pela rodada, que confere a pessoa de novo.",
      })
      .eq("id", d.retida.id)
      .eq("organization_id", d.organizationId)
      .eq("status", "queued");
    if (error) {
      logger.error("[campanha] a mensagem retida não saiu da fila física", {
        mensagem: d.retida.id,
        destinatario: d.destinatarioId,
        erro: error.message,
      });
    }
  }
  const motivo = (d.retida.metadata as { queued_reason?: string } | null | undefined)?.queued_reason ?? null;
  const certa = retidaPeloCanal(d.retida);
  const semRegistro = (codigo: string, erro: string) => {
    logger.error("[campanha] o desfecho da fila do canal não foi gravado", {
      destinatario: d.destinatarioId,
      codigo,
      erro,
    });
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "fila:sem_registro" };
  };
  if (d.indiceDoDesfecho === 0 && certa) {
    const { error } = await admin
      .from("campaign_recipients")
      .update({
        status: "pending",
        sending_at: null,
        next_attempt_at: new Date(d.agora.getTime() + 60_000).toISOString(),
        last_error_code: "canal_indisponivel",
        last_error_detail: motivo,
      })
      .eq("id", d.destinatarioId)
      .eq("status", "sending");
    if (error) return semRegistro("canal_indisponivel", error.message);
    return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: "fila:canal_indisponivel" };
  }
  const codigo = certa ? "canal_indisponivel" : "envio_incerto";
  const { error } = await admin
    .from("campaign_recipients")
    .update({
      status: "failed",
      last_error_code: codigo,
      last_error_detail: motivo,
      message_id: d.primeiraId,
    })
    .eq("id", d.destinatarioId)
    .eq("status", "sending");
  // O número conta como usado nos dois casos: o começo, ou a própria mensagem, pode ter saído.
  if (error) return { ...semRegistro(codigo, error.message), numero: d.numero };
  return { enviadas: 0, pulados: 0, concluidas: 0, detalhe: `fila:${codigo}`, numero: d.numero };
}

/**
 * O que a exceção do envio faz com o destinatário já reservado (`sending`).
 * Exportada para o teste: o caminho inteiro da rodada precisa de ritmo, canal
 * e pool.
 *
 * Organização parada entre a leitura da rodada e o envio (`OrgNaoOperanteError`
 * da porta de saída) NÃO é falha do destinatário: ele volta a `pending` e sai
 * na reativação, no ritmo da campanha. Marcar `send_exception` o tiraria da
 * campanha para sempre por algo que não é dele.
 */
export async function registrarExcecaoDoEnvio(
  admin: SupabaseClient,
  destinatarioId: string,
  err: unknown,
  agora: Date = new Date(),
): Promise<string> {
  // O veto da conferência final no handler (F4g, A3): nada saiu, e o
  // destinatário segue o veto — pulado, de volta à fila ou cancelado —, nunca
  // `send_exception`, que o tiraria da campanha por um motivo que não é dele.
  if (err instanceof VetoDaCampanhaError) return aplicarVeto(admin, destinatarioId, err.veto, agora);
  if (err instanceof OrgNaoOperanteError) {
    await admin
      .from("campaign_recipients")
      .update({ status: "pending", sending_at: null })
      .eq("id", destinatarioId)
      .eq("status", "sending");
    return "org_nao_operante";
  }
  const motivoErro = err instanceof Error ? err.message : String(err);
  await admin
    .from("campaign_recipients")
    .update({
      status: "failed",
      last_error_code: "send_exception",
      last_error_detail: motivoErro.slice(0, 300),
    })
    .eq("id", destinatarioId)
    .eq("status", "sending");
  return "falhou";
}

/**
 * Reserva o destinatário para ESTA rodada: `pending` → `sending`, em
 * compare-and-set.
 *
 * ═══ Por que o erro é devolvido, e não engolido ═══
 *
 * A primeira versão lia só o `data` do update. Qualquer falha dura — e houve
 * uma, a FK de `message_id` — virava "zero linhas", que o chamador lia como
 * "outro worker ganhou a corrida". Resultado medido em produção: a campanha
 * ficava `running` para sempre, o destinatário `pending` com zero tentativas, e
 * o cron respondia `ja_reservado` a cada minuto. Um erro disfarçado de
 * concorrência é a pior espécie: ele descreve um sistema saudável.
 *
 * ═══ Por que a campanha é relida DEPOIS da reserva ═══
 *
 * O compare-and-set confere só o destinatário. O worker que escolheu o pendente
 * antes de a campanha ser cancelada ou pausada o reservava depois, e a mensagem
 * saía com a campanha já parada; cancelar a fila primeiro não fechava tudo (um
 * 429 devolve `sending` a `pending` entre as duas escritas, e a fila pode falhar
 * sozinha). Com a campanha caindo PRIMEIRO no cancelamento (`cancelarAcao`) e
 * relida aqui, toda reserva feita depois da queda a enxerga e se desfaz: na
 * cancelada, o destinatário fica cancelado; na pausada, volta à fila para a
 * retomada. Sem conseguir ler a campanha, também se desfaz (falha fechada).
 */
export async function reservarDestinatario(
  admin: SupabaseClient,
  destinatarioId: string,
  agora: Date,
): Promise<{ reservado: boolean; erro?: string; parou?: true }> {
  const { data, error } = await admin
    .from("campaign_recipients")
    .update({
      status: "sending",
      sending_at: agora.toISOString(),
      last_attempt_at: agora.toISOString(),
      attempt_count: 1,
    })
    .eq("id", destinatarioId)
    .eq("status", "pending")
    .select("id, campaign_id");
  if (error) {
    logger.warn("[campanha] reserva do destinatário falhou", {
      destinatario: destinatarioId,
      motivo: error.message,
    });
    return { reservado: false, erro: error.message };
  }
  const reservado = (data ?? [])[0] as { campaign_id?: string } | undefined;
  if (!reservado) return { reservado: false };

  const { data: campanha, error: erroDaCampanha } = await admin
    .from("campaigns")
    .select("status")
    .eq("id", reservado.campaign_id ?? "")
    .maybeSingle();
  const status = (campanha as { status?: string } | null)?.status;
  if (!erroDaCampanha && status === "running") return { reservado: true };

  await admin
    .from("campaign_recipients")
    .update(
      !erroDaCampanha && status === "cancelled"
        ? { status: "cancelled", cancelled_at: agora.toISOString(), sending_at: null }
        : { status: "pending", sending_at: null },
    )
    .eq("id", destinatarioId)
    .eq("status", "sending");
  if (erroDaCampanha) {
    logger.warn("[campanha] sem ler a campanha depois da reserva; reserva desfeita", {
      destinatario: destinatarioId,
      motivo: erroDaCampanha.message,
    });
    return { reservado: false, erro: erroDaCampanha.message };
  }
  return { reservado: false, parou: true };
}

/**
 * Os números que esta campanha pode usar: o principal mais os vinculados.
 *
 * Falha ABERTA no principal: se a consulta dos vinculados quebrar, a campanha
 * segue falando pelo número principal em vez de parar. Rodízio é otimização;
 * parar de enviar por causa dela seria o remédio pior que a doença.
 */
async function numerosDaCampanha(admin: SupabaseClient, campanha: CampanhaRow): Promise<string[]> {
  const { data, error } = await admin
    .from("campaign_channel_sessions")
    .select("channel_session_id")
    .eq("organization_id", campanha.organization_id)
    .eq("campaign_id", campanha.id);
  if (error) {
    logger.warn("[campanha] pool de números falhou; seguindo pelo principal", {
      campanha: campanha.id,
      motivo: error.message,
    });
    return [campanha.channel_session_id];
  }
  return poolDaCampanha(
    campanha.channel_session_id,
    (data ?? []).map((l) => (l as { channel_session_id: string }).channel_session_id),
  );
}

/**
 * O número em que esta pessoa JÁ conversa, se houver.
 *
 * A conversa mais recente ganha: se ela falou com dois números da empresa, o
 * último é o que ela tem na cabeça.
 */
async function numeroDoHistorico(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  contactId: string,
): Promise<string | null> {
  const { data } = await admin
    .from("conversations")
    .select("channel_session_id, last_message_at")
    .eq("organization_id", campanha.organization_id)
    .eq("contact_id", contactId)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(1);
  const linha = (data ?? [])[0] as { channel_session_id: string } | undefined;
  return linha?.channel_session_id ?? null;
}

/** Quantas saíram hoje e na última hora, mais o último envio — o estado do ritmo. */
export async function estadoDeEnvio(
  admin: SupabaseClient,
  campanhaId: string,
  agora: Date,
  fuso: string,
): Promise<{ ultimoEnvio: Date | null; enviadasHoje: number; enviadasNaUltimaHora: number }> {
  // O dia do teto diário é o dia DO CLIENTE, como o resto do ritmo. Ver a nota
  // no chamador: `setUTCHours` fazia o dia virar 21h em `America/Sao_Paulo`.
  const inicioDoDia = dayStartInTz(agora, fuso);
  const { data } = await admin
    .from("campaign_recipients")
    .select("sent_at")
    .eq("campaign_id", campanhaId)
    .not("sent_at", "is", null)
    .gte("sent_at", inicioDoDia.toISOString())
    .order("sent_at", { ascending: false });

  const enviados = (data ?? []).map((r) => new Date((r as { sent_at: string }).sent_at));
  const umaHoraAtras = agora.getTime() - 3_600_000;
  return {
    ultimoEnvio: enviados[0] ?? null,
    enviadasHoje: enviados.length,
    enviadasNaUltimaHora: enviados.filter((d) => d.getTime() >= umaHoraAtras).length,
  };
}

/** Exportado só para a tela e o teste lerem a mesma frase do motivo. */
export { TEXTO_DA_EXCLUSAO };


/** Os valores do modelo congelados em `variables.modelo`, ou `null` se não há. */
function valoresCongelados(variables: unknown): Record<string, string> | null {
  if (!variables || typeof variables !== "object") return null;
  const modelo = (variables as Record<string, unknown>).modelo;
  if (!modelo || typeof modelo !== "object" || Array.isArray(modelo)) return null;
  const saida: Record<string, string> = {};
  for (const [k, v] of Object.entries(modelo as Record<string, unknown>)) {
    if (typeof v === "string") saida[k] = v;
  }
  return saida;
}

/**
 * A falha que vale para o envio inteiro, chegada DEPOIS do envio (webhook), desde
 * que a campanha começou ou foi retomada. "Desde a retomada" importa: quem
 * corrigiu o modelo e retomou não pode ver a campanha parar de novo pela falha
 * velha que causou a primeira pausa.
 */
export async function falhaQueParaACampanha(
  admin: SupabaseClient,
  campanha: Pick<CampanhaRow, "id" | "started_at" | "paused_at">,
): Promise<{ codigo: string; detalhe: string | null } | null> {
  const desde = [campanha.started_at, campanha.paused_at]
    .filter((d): d is string => typeof d === "string")
    .sort()
    .pop();
  let consulta = admin
    .from("campaign_recipients")
    .select("last_error_code, last_error_detail")
    .eq("campaign_id", campanha.id)
    .eq("status", "failed")
    .order("updated_at", { ascending: false })
    .limit(20);
  if (desde) consulta = consulta.gt("updated_at", desde);
  const { data } = await consulta;
  for (const linha of (data ?? []) as Array<{ last_error_code: string | null; last_error_detail: string | null }>) {
    const codigo = codigoDaPlataforma(linha.last_error_code, linha.last_error_detail);
    if (falhaDoEnvioInteiro(codigo)) {
      return { codigo: codigo!, detalhe: fraseDaFalha(codigo, linha.last_error_detail) };
    }
  }
  return null;
}

/**
 * A pausa do envio que não entrou no teto do número (F4l, L03/L06 do cxj). A
 * frase vai à tela em `failure_detail`, traduzida pelo dicionário.
 */
const TETO_SEM_REGISTRO = {
  codigo: "teto_sem_registro",
  detalhe: "Um envio não entrou na contagem do limite diário do número.",
} as const;

/**
 * Pausa a campanha do envio e as outras em andamento cujo número PRINCIPAL é o do
 * envio: elas leriam o ledger sem a mensagem, e o número passaria do teto do dia
 * (F4l, L06 do cxj; na Linha A, o 1º toque, o 2º e a despedida dividem o chip). A
 * que só usa o número no rodízio segue. A escrita recusada fica no log: sem ela,
 * ninguém saberia que a campanha continuou mandando.
 */
async function pausarPeloTetoSemRegistro(
  admin: SupabaseClient,
  campanha: CampanhaRow,
  numero: string,
  agora: Date,
): Promise<void> {
  const pausa = {
    status: "paused",
    paused_at: agora.toISOString(),
    failure_code: TETO_SEM_REGISTRO.codigo,
    failure_detail: TETO_SEM_REGISTRO.detalhe,
  };
  const daCampanha = await admin.from("campaigns").update(pausa).eq("id", campanha.id).eq("status", "running");
  const doNumero = await admin
    .from("campaigns")
    .update(pausa)
    .eq("organization_id", campanha.organization_id)
    .eq("channel_session_id", numero)
    .eq("status", "running");
  const recusa = daCampanha.error ?? doNumero.error;
  if (recusa) {
    logger.error("[campanha] a pausa do teto sem registro não foi gravada", {
      campanha: campanha.id,
      numero,
      motivo: recusa.message,
    });
  }
}

/**
 * Pausa por falha do envio inteiro, com o motivo em `failure_code`/`failure_detail`
 * — a tela de detalhe mostra a frase, e retomar é decisão de quem opera, depois
 * de corrigir (o modelo, o pagamento, a qualidade do número).
 */
async function pausarPorFalha(
  admin: SupabaseClient,
  campanhaId: string,
  falha: { codigo: string; detalhe: string | null },
  agora: Date,
): Promise<void> {
  await admin
    .from("campaigns")
    .update({
      status: "paused",
      paused_at: agora.toISOString(),
      failure_code: falha.codigo,
      failure_detail: falha.detalhe,
    })
    .eq("id", campanhaId)
    .eq("status", "running");
}
