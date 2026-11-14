/**
 * O CHIP DE PROSPECÇÃO — a trava de todo emissor automático que não é a campanha (Linha A, v20).
 *
 * ═══ O defeito ═══
 *
 * A campanha de prospecção confere a pessoa e a hora até o último passo (`conferencia.ts`, `rodada.ts`). Mas o mesmo
 * número fala por outros caminhos automáticos: o retorno que o agente marca sozinho (`callback_enabled`), o follow-up
 * de fluxo (inclusive a inscrição `dormente`, que acorda, vira `active` e manda), a retomada da IA, a automação e a
 * integração por token. Nenhum deles conhecia a prospecção: um retorno marcado na quinta saía no feriado de sexta, e
 * um follow-up de fluxo falava com quem ganhou a etiqueta `sair` depois da preparação.
 *
 * ═══ A regra ═══
 *
 * Um número é de prospecção quando alguma campanha de interesse legítimo (`base_legal = 'legitimate_interest'`), em
 * qualquer status menos rascunho, o usa como principal ou no rodízio. Nesse número, todo envio automático que NÃO é
 * resposta a quem escreveu e NÃO é a própria campanha (que tem a conferência dela) só sai:
 *
 *  - dentro da janela de disparo do número (`window_start_hour`/`window_end_hour`), nos dias da prospecção
 *    (`prospeccao_dias`) e fora de feriado nacional — a mesma régua que a campanha de prospecção usa;
 *  - para quem não está bloqueado (SAIR), não tem etiqueta de parada de nenhuma campanha de prospecção do número
 *    (`audience_filter.sem_tags`), não pediu atendimento humano (`force_human`, `ai_opt_out`), não recusou marketing,
 *    não está na lista de exclusão e não está numa conversa aberta com uma pessoa no comando.
 *
 * A hora é janela da CONFIGURAÇÃO: nada aqui fixa hora. A resposta a quem escreveu segue as regras dela (a janela de
 * resposta e o teto, que ela não gasta).
 *
 * Falha FECHADA: sem ler a campanha, o contato, a lista ou as conversas, não sai.
 *
 * Duas leituras, a mesma decisão: `travaDoChipPorPg` (a cadeia do agente, que tem a conexão do worker) e
 * `travaDoChipPorSupabase` (o handler de mensagens, porta de saída da automação e da integração).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { janelaDeProspeccaoAberta, proximaAberturaDaProspeccao } from "@/lib/agent-engine/pacing/engine";
import type { PacingKnobs } from "@/lib/agent-engine/pacing/defaults";
import { loadChannelKnobs } from "@/lib/agent-engine/pacing/store";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";
import { STATUS_ENCERRADOS, STATUS_ENCERRADOS_LISTA, silencioVigente } from "@/lib/inbox/comando-da-conversa";
import { feriadosDoBrasilDoAno } from "@/lib/lgpd/holidays-br";

import { recusouMarketing } from "./elegibilidade";
import { hashDoEndereco } from "./exclusoes";

/** O mínimo de banco que a leitura por conexão usa (`pg.Pool`, `pg.PoolClient`). */
interface Consultavel {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type MotivoDaHoraNoChip = "fora_da_janela_de_prospeccao" | "feriado_nacional";
export type MotivoDaPessoaNoChip =
  | "contato_bloqueado"
  | "etiqueta_de_parada"
  | "atendimento_humano"
  | "recusou_marketing"
  | "suprimido";
export type MotivoDoChip = MotivoDaHoraNoChip | MotivoDaPessoaNoChip | "sem_leitura";

/** A recusa: o motivo e, quando é de hora, a próxima abertura (dia da prospecção, fora de feriado). */
export interface TravaDoChip {
  motivo: MotivoDoChip;
  proximaAbertura?: Date;
}

/** O dia de `agora`, no fuso dado, é feriado nacional (`lib/lgpd/holidays-br.ts`, a régua única do CRM)? */
export function ehFeriadoNacional(agora: Date, fuso: string): boolean {
  const dia = new Intl.DateTimeFormat("sv-SE", {
    timeZone: fuso,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(agora);
  return feriadosDoBrasilDoAno(Number(dia.slice(0, 4))).includes(dia);
}

/** A hora do número de prospecção: a janela de disparo, os dias da prospecção e o feriado nacional. */
export function motivoDaHoraNoChip(agora: Date, knobs: PacingKnobs): MotivoDaHoraNoChip | null {
  if (!janelaDeProspeccaoAberta(agora, knobs)) return "fora_da_janela_de_prospeccao";
  if (ehFeriadoNacional(agora, knobs.timezone)) return "feriado_nacional";
  return null;
}

/** A próxima abertura da prospecção que não cai em feriado nacional (sem jitter: quem adia soma o dele). */
export function proximaAberturaSemFeriado(agora: Date, knobs: PacingKnobs): Date {
  let t = agora;
  // 30 aberturas cobrem qualquer sequência de feriados com folga; o laço não fica sem fim com knobs tortos.
  for (let i = 0; i < 30; i += 1) {
    const abre = proximaAberturaDaProspeccao(t, knobs, () => 0);
    if (!ehFeriadoNacional(abre, knobs.timezone)) return abre;
    t = abre;
  }
  return proximaAberturaDaProspeccao(t, knobs, () => 0);
}

/** As etiquetas de parada das campanhas de prospecção do número (`audience_filter.sem_tags`). */
export function paradasDoFiltro(filtros: readonly unknown[]): string[] {
  const todas = new Set<string>();
  for (const filtro of filtros) {
    const lista = (filtro as { sem_tags?: unknown } | null)?.sem_tags;
    if (!Array.isArray(lista)) continue;
    for (const t of lista) if (typeof t === "string" && t.trim() !== "") todas.add(t);
  }
  return [...todas];
}

export interface ContatoDoChip {
  is_blocked: boolean | null;
  tags: string[] | null;
  force_human: boolean | null;
  ai_opt_out: boolean | null;
  consent: unknown;
  phone_number: string | null;
}

/** A pessoa, sem a lista de exclusão e as conversas (que dependem de leitura). */
export function motivoDaPessoaNoChip(contato: ContatoDoChip, paradas: readonly string[]): MotivoDaPessoaNoChip | null {
  if (contato.is_blocked === true) return "contato_bloqueado";
  if ((contato.tags ?? []).some((t) => paradas.includes(t))) return "etiqueta_de_parada";
  if (contato.force_human === true || contato.ai_opt_out === true) return "atendimento_humano";
  if (recusouMarketing(contato.consent)) return "recusou_marketing";
  return null;
}

const COLUNAS_DO_CONTATO = "is_blocked, tags, force_human, ai_opt_out, consent, phone_number";

/**
 * A trava pela conexão do worker (a cadeia do agente). `null` = pode sair, ou o número não é de prospecção.
 * `hora: false` pula a hora (quem chama já a confere com a própria régua).
 */
export async function travaDoChipPorPg(
  db: Consultavel,
  alvo: { organizationId: string; channelSessionId: string; contactId: string },
  agora: Date,
  opcoes: { hora?: boolean } = {},
): Promise<TravaDoChip | null> {
  let filtros: unknown[];
  try {
    // A marca na linha: só conta a linha que veio desta consulta (um dublê que devolve a mesma linha a toda
    // consulta não transforma um número qualquer em número de prospecção; o banco de verdade sempre a devolve).
    const { rows: lidas } = await db.query(
      `select 'prospeccao' as marca_da_prospeccao, k.audience_filter from campaigns k
        where k.organization_id = $1 and k.base_legal = 'legitimate_interest' and k.status <> 'draft'
          and (k.channel_session_id = $2::uuid
               or exists (select 1 from campaign_channel_sessions p
                           where p.organization_id = k.organization_id and p.campaign_id = k.id
                             and p.channel_session_id = $2::uuid))`,
      [alvo.organizationId, alvo.channelSessionId],
    );
    const rows = (lidas ?? []) as Array<{ audience_filter: unknown; marca_da_prospeccao?: unknown } | null>;
    const daProspeccao = rows.filter((r): r is { audience_filter: unknown } => r?.marca_da_prospeccao === "prospeccao");
    if (daProspeccao.length === 0) return null;
    filtros = daProspeccao.map((r) => r.audience_filter);
  } catch {
    return { motivo: "sem_leitura" };
  }
  try {
    if (opcoes.hora !== false) {
      const { knobs } = await loadChannelKnobs(db as never, alvo.organizationId, alvo.channelSessionId);
      const hora = motivoDaHoraNoChip(agora, knobs);
      if (hora) return { motivo: hora, proximaAbertura: proximaAberturaSemFeriado(agora, knobs) };
    }
    const { rows: contatos } = await db.query(
      `select ${COLUNAS_DO_CONTATO} from contacts where organization_id = $1 and id = $2::uuid`,
      [alvo.organizationId, alvo.contactId],
    );
    const contato = contatos[0] as ContatoDoChip | undefined;
    if (!contato) return { motivo: "sem_leitura" };
    const pessoa = motivoDaPessoaNoChip(contato, paradasDoFiltro(filtros));
    if (pessoa) return { motivo: pessoa };
    const telefone = (contato.phone_number ?? "").trim();
    if (telefone !== "") {
      const { rows: lista } = await db.query(
        `select 1 from campaign_suppressions where organization_id = $1 and recipient_address_hash = $2 limit 1`,
        [alvo.organizationId, hashDoEndereco(telefone)],
      );
      if (lista.length > 0) return { motivo: "suprimido" };
    }
    const { rows: comPessoa } = await db.query(
      `select 1 from conversations
        where organization_id = $1 and contact_id = $2::uuid
          and status <> all($3::text[])
          and (assigned_to_user_id is not null
               or (bot_silenced_until is not null and bot_silenced_until > $4::timestamptz))
        limit 1`,
      [alvo.organizationId, alvo.contactId, [...STATUS_ENCERRADOS_LISTA], agora.toISOString()],
    );
    if (comPessoa.length > 0) return { motivo: "atendimento_humano" };
    return null;
  } catch {
    return { motivo: "sem_leitura" };
  }
}

/** A mesma trava pelo cliente do PostgREST (o handler de mensagens). */
export async function travaDoChipPorSupabase(
  admin: SupabaseClient,
  alvo: { organizationId: string; channelSessionId: string; contactId: string },
  agora: Date,
  opcoes: { hora?: boolean } = {},
): Promise<TravaDoChip | null> {
  try {
    return await travaPeloPostgrest(admin, alvo, agora, opcoes);
  } catch {
    // Uma leitura que lança (e não só a que devolve `error`) também não deixa sair: falha fechada.
    return { motivo: "sem_leitura" };
  }
}

async function travaPeloPostgrest(
  admin: SupabaseClient,
  alvo: { organizationId: string; channelSessionId: string; contactId: string },
  agora: Date,
  opcoes: { hora?: boolean },
): Promise<TravaDoChip | null> {
  // Só `select`/`eq`/`in` no PostgREST, e o recorte da base legal e do status em código: a mesma pergunta da
  // consulta por conexão, com o mínimo de operadores.
  type LinhaDaCampanha = { audience_filter: unknown; base_legal: string | null; status: string | null };
  const daProspeccao = (linhas: unknown): unknown[] =>
    ((linhas ?? []) as LinhaDaCampanha[])
      .filter((r) => r?.base_legal === "legitimate_interest" && r?.status !== "draft")
      .map((r) => r.audience_filter);
  const [direto, pelaLista] = await Promise.all([
    admin
      .from("campaigns")
      .select("audience_filter, base_legal, status")
      .eq("organization_id", alvo.organizationId)
      .eq("channel_session_id", alvo.channelSessionId),
    admin
      .from("campaign_channel_sessions")
      .select("campaign_id")
      .eq("organization_id", alvo.organizationId)
      .eq("channel_session_id", alvo.channelSessionId),
  ]);
  if (direto.error || pelaLista.error) return { motivo: "sem_leitura" };
  const filtros: unknown[] = daProspeccao(direto.data);
  const doRodizio = ((pelaLista.data ?? []) as Array<{ campaign_id: string }>).map((r) => r.campaign_id);
  if (doRodizio.length > 0) {
    const { data, error } = await admin
      .from("campaigns")
      .select("audience_filter, base_legal, status")
      .eq("organization_id", alvo.organizationId)
      .in("id", doRodizio);
    if (error) return { motivo: "sem_leitura" };
    filtros.push(...daProspeccao(data));
  }
  if (filtros.length === 0) return null;

  if (opcoes.hora !== false) {
    let knobs: PacingKnobs;
    try {
      knobs = await knobsDoCanal(admin, alvo.organizationId, alvo.channelSessionId);
    } catch {
      return { motivo: "sem_leitura" };
    }
    const hora = motivoDaHoraNoChip(agora, knobs);
    if (hora) return { motivo: hora, proximaAbertura: proximaAberturaSemFeriado(agora, knobs) };
  }

  const { data: lido, error: erroDoContato } = await admin
    .from("contacts")
    .select(COLUNAS_DO_CONTATO)
    .eq("organization_id", alvo.organizationId)
    .eq("id", alvo.contactId)
    .maybeSingle();
  if (erroDoContato || !lido) return { motivo: "sem_leitura" };
  const contato = lido as unknown as ContatoDoChip;
  const pessoa = motivoDaPessoaNoChip(contato, paradasDoFiltro(filtros));
  if (pessoa) return { motivo: pessoa };

  const telefone = (contato.phone_number ?? "").trim();
  if (telefone !== "") {
    const { data: lista, error } = await admin
      .from("campaign_suppressions")
      .select("id")
      .eq("organization_id", alvo.organizationId)
      .in("recipient_address_hash", [hashDoEndereco(telefone)])
      .limit(1);
    if (error) return { motivo: "sem_leitura" };
    if ((lista ?? []).length > 0) return { motivo: "suprimido" };
  }

  const { data: conversas, error: erroDasConversas } = await admin
    .from("conversations")
    .select("status, assigned_to_user_id, bot_silenced_until")
    .eq("organization_id", alvo.organizationId)
    .eq("contact_id", alvo.contactId);
  if (erroDasConversas) return { motivo: "sem_leitura" };
  const comPessoa = (
    (conversas ?? []) as Array<{ status: string | null; assigned_to_user_id: string | null; bot_silenced_until: string | null }>
  ).some(
    (c) =>
      !STATUS_ENCERRADOS.has(c.status ?? "") &&
      (!!c.assigned_to_user_id || silencioVigente(c.bot_silenced_until, agora).vigente),
  );
  if (comPessoa) return { motivo: "atendimento_humano" };
  return null;
}

/** A frase do motivo, para o log e o erro (sem dado pessoal). */
export const FRASE_DA_TRAVA_DO_CHIP: Record<MotivoDoChip, string> = {
  fora_da_janela_de_prospeccao: "Número de prospecção: fora da janela de disparo ou dos dias da prospecção.",
  feriado_nacional: "Número de prospecção: hoje é feriado nacional.",
  contato_bloqueado: "Número de prospecção: o contato pediu para sair.",
  etiqueta_de_parada: "Número de prospecção: o contato tem uma etiqueta de parada da campanha.",
  atendimento_humano: "Número de prospecção: o contato está com atendimento humano.",
  recusou_marketing: "Número de prospecção: o contato recusou marketing.",
  suprimido: "Número de prospecção: o contato está na lista de exclusão.",
  sem_leitura: "Número de prospecção: não foi possível conferir o contato agora.",
};
