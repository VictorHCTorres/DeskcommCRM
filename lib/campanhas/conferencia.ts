/**
 * A conferência de quem vai receber uma campanha, no instante do envio.
 *
 * Mora fora da `rodada.ts` porque o handler de mensagens também a chama (pela
 * `entrega.ts`), e a rodada importa o handler: dentro dela, a conferência faria
 * um ciclo de importação.
 *
 * ═══ Onde ela roda (revisão F4g do cxj, 11/11/2026) ═══
 *
 * A primeira conferência roda antes do ritmo (pular não gasta janela). Na
 * prospecção, a `conferenciaFinal` roda de novo DEPOIS da reserva, de novo logo
 * antes do 1º balão (depois de abrir a conversa), no próprio handler (no começo
 * e no instante do efeito do provedor, pela `entrega.ts`) e antes de cada balão
 * seguinte. Cada uma dessas janelas deixou passar um caso concreto na revisão:
 * o `ai_opt_out` que ninguém lia, a recusa de marketing e a lista de exclusão
 * lidas só antes da reserva, a resposta que chegava enquanto a conversa era
 * aberta, e o cancelamento entre um balão e outro.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { samePhone } from "@/lib/channels/phone-variants";
import { logger } from "@/lib/logger";
import { STATUS_ENCERRADOS, silencioVigente } from "@/lib/inbox/comando-da-conversa";

import { motivoParaExcluir, recusouMarketing, statusDaSaida } from "./elegibilidade";
import type { VetoDaCampanha } from "./entrega";
import { hashDoEndereco } from "./exclusoes";
import type { MotivoDeExclusao } from "./tipos";

/** O destinatário com o contato embutido: o que a fila lê e o que a prospecção relê depois da reserva. */
export const COLUNAS_DO_DESTINATARIO =
  "id, contact_id, recipient_address, rendered_body, variables, " +
  "contacts(id, name, display_name, phone_number, is_blocked, is_personal, is_anonymized, consent, " +
  "tags, force_human, ai_opt_out, is_merged_into)";

export interface DestinatarioRow {
  id: string;
  contact_id: string;
  recipient_address: string | null;
  rendered_body: string | null;
  /** `{ nome, modelo? }` — com modelo, os valores congelados na preparação. */
  variables: unknown;
  contacts: {
    id: string;
    name: string | null;
    display_name: string | null;
    phone_number: string | null;
    is_blocked: boolean;
    is_personal: boolean;
    is_anonymized: boolean;
    consent: unknown;
    /** Os quatro abaixo só decidem na prospecção (`travaDaProspeccao`). */
    tags: string[] | null;
    force_human: boolean | null;
    ai_opt_out?: boolean | null;
    is_merged_into: string | null;
  } | null;
}

/** O que a conferência precisa da campanha. */
export interface CampanhaDaConferencia {
  organization_id: string;
  /** `legitimate_interest` = prospecção: abordagem fria, apoiada na avaliação de legítimo interesse (LIA). */
  base_legal: string | null;
  /** O instante da fotografia da audiência: o que mudou depois, a preparação não viu. */
  prepared_at: string | null;
  /** O filtro da audiência (`audiencia.ts`); a conferência lê `sem_tags` e `funis`. */
  audience_filter: unknown;
}

/**
 * Prospecção é a campanha de base `legitimate_interest`: abordagem fria, sem
 * consentimento prévio, apoiada numa avaliação de legítimo interesse (LIA). Só
 * a ela valem a revalidação da fotografia, o feriado e os dias próprios do
 * número; a campanha de consentimento segue como sempre foi.
 */
export function ehProspeccao(campanha: { base_legal: string | null }): boolean {
  return campanha.base_legal === "legitimate_interest";
}

/** Uma lista de textos do filtro da audiência (`sem_tags`, `funis`); o que não for lista de texto vira vazio. */
export function textosDoFiltro(filtro: unknown, chave: "sem_tags" | "funis"): readonly string[] {
  const valor = (filtro as Record<string, unknown> | null)?.[chave];
  return Array.isArray(valor) ? valor.filter((t): t is string => typeof t === "string") : [];
}

export type Trava = { pular: MotivoDeExclusao } | { esperar: "sem_leitura" | "sem_preparacao" } | null;

/**
 * A pessoa ESCREVEU depois de `corte`? `null` = não deu para ler (quem chama não manda).
 *
 * Reação não é fala (`type = 'reaction'`, o 👍 no toque): conta como resposta só
 * o que a pessoa escreveu. E o histórico importado do celular
 * (`lib/channels/historico`) entra no banco HOJE com mensagens de meses atrás:
 * para ele vale a hora em que a pessoa mandou (`sent_at`, a do acervo), não a
 * da importação. A marca é `metadata.historico_importado = 'true'`, e o
 * importador é o único que a escreve. Qualquer outra coisa na marca — nenhuma,
 * ou um `'false'` (F4g, G09) — é do caminho ao vivo e conta pela hora em que
 * chegou: são duas consultas, porque `neq` do PostgREST não devolve o nulo.
 */
export async function escreveuDepoisDe(
  admin: SupabaseClient,
  organizacaoId: string,
  contatoId: string,
  corte: string,
): Promise<boolean | null> {
  const entradas = () =>
    admin
      .from("messages")
      .select("id")
      .eq("organization_id", organizacaoId)
      .eq("contact_id", contatoId)
      .eq("direction", "inbound")
      .neq("type", "reaction");
  const consultas = [
    () => entradas().is("metadata->>historico_importado", null).gt("created_at", corte).limit(1),
    () => entradas().neq("metadata->>historico_importado", "true").gt("created_at", corte).limit(1),
    () => entradas().eq("metadata->>historico_importado", "true").gt("sent_at", corte).limit(1),
  ];
  for (const consulta of consultas) {
    const { data, error } = await consulta();
    if (error) return null;
    if ((data ?? []).length > 0) return true;
  }
  return false;
}

/**
 * Os vetos da PESSOA, que valem para toda campanha: bloqueio (opt-out), contato
 * pessoal, anonimizado, recusa de marketing, telefone inválido e a lista de
 * exclusão da operação.
 *
 * A lista é conferida pelos DOIS endereços — o do cadastro de agora e o
 * aprovado na preparação —, porque o hash compara dígitos: a mesma pessoa
 * escrita com e sem o nono dígito são dois hashes. E é lida com `limit(1)`, não
 * com `maybeSingle`: duas linhas do mesmo número (cadastradas em grafias
 * diferentes) davam erro, e o erro era lido como "não está na lista".
 *
 * Falha FECHADA: sem ler a lista, `esperar` (F4g, A2).
 */
export async function vetosDaPessoa(
  admin: SupabaseClient,
  campanha: { organization_id: string },
  alvo: DestinatarioRow,
): Promise<{ pular: MotivoDeExclusao } | { esperar: "sem_leitura" } | null> {
  const contato = alvo.contacts;
  const motivo = motivoParaExcluir({
    contactId: alvo.contact_id,
    telefone: contato?.phone_number ?? alvo.recipient_address,
    bloqueado: !!contato?.is_blocked,
    pessoal: !!contato?.is_personal,
    anonimizado: !!contato?.is_anonymized,
    recusouMarketing: recusouMarketing(contato?.consent),
  });
  if (motivo) return { pular: motivo };

  const enderecos = [contato?.phone_number, alvo.recipient_address]
    .map((e) => (e ?? "").trim())
    .filter((e) => e !== "");
  const hashes = [...new Set(enderecos.map(hashDoEndereco))];
  if (hashes.length === 0) return null;
  const { data, error } = await admin
    .from("campaign_suppressions")
    .select("id")
    .eq("organization_id", campanha.organization_id)
    .in("recipient_address_hash", hashes)
    .limit(1);
  if (error) return { esperar: "sem_leitura" };
  return (data ?? []).length > 0 ? { pular: "suprimido" } : null;
}

/**
 * A fotografia da preparação, revalidada no instante do envio — só na prospecção.
 *
 * A preparação escolheu quem recebe pelo cadastro daquela hora; o envio sai
 * horas depois. Nesse meio-tempo a pessoa pode ter respondido ao toque
 * anterior, ganhado a etiqueta de parada (no contato ou no negócio), ido para
 * atendimento humano (no contato, no `ai_opt_out` ou na conversa), sido
 * mesclada em outro contato ou trocado de número. A resposta só fecha o
 * destinatário que JÁ recebeu (`resposta.ts`); este ainda não recebeu nada desta
 * campanha e, sem esta conferência, recebia o toque seguinte minutos depois de
 * responder ao anterior.
 *
 * Falha FECHADA: sem ler as mensagens, as conversas ou os negócios, não manda
 * agora; sem `prepared_at` não há corte para "escreveu depois", e também não.
 * Mensagem fria que sai sem a conferência não se desfaz.
 */
export async function travaDaProspeccao(
  admin: SupabaseClient,
  campanha: CampanhaDaConferencia,
  alvo: DestinatarioRow,
  agora: Date,
): Promise<Trava> {
  if (!campanha.prepared_at) return { esperar: "sem_preparacao" };
  const contato = alvo.contacts;
  const paradas = textosDoFiltro(campanha.audience_filter, "sem_tags");
  const temParada = (tags: readonly string[] | null | undefined) => (tags ?? []).some((t) => paradas.includes(t));

  if (temParada(contato?.tags)) return { pular: "etiqueta_de_parada" };
  // `ai_opt_out`: a pessoa pediu para falar com gente, e não com a IA. A
  // conversa que o toque abre é atendida pela IA do número (F4g, A1).
  if (contato?.force_human === true || contato?.ai_opt_out === true) return { pular: "atendimento_humano" };
  if (contato?.is_merged_into) return { pular: "contato_mesclado" };
  // O número congelado na preparação contra o de agora: quem a preparação
  // conferiu foi o congelado, e é só para ele que o handler manda (F4g, A5).
  // Sem o congelado não há destino conferido. A mesma pessoa com e sem o nono
  // dígito, ou com outra pontuação, não é troca (`samePhone` compara só os
  // dígitos, nas duas grafias do celular).
  const congelado = (alvo.recipient_address ?? "").trim();
  const atual = (contato?.phone_number ?? "").trim();
  if (congelado === "") return { pular: "destino_mudou" };
  if (atual !== "" && !samePhone(congelado, atual)) return { pular: "destino_mudou" };

  // A conversa com uma pessoa no comando: atendente dono dela, ou o automático
  // calado (por um atendente que respondeu agora, ou pausado). É o mesmo
  // silêncio que o inbox lê (`comandoDaConversa`). Conversa encerrada é
  // histórico, mesmo com o dono antigo ainda gravado.
  const { data: conversas, error: erroDasConversas } = await admin
    .from("conversations")
    .select("status, assigned_to_user_id, bot_silenced_until")
    .eq("organization_id", campanha.organization_id)
    .eq("contact_id", alvo.contact_id);
  if (erroDasConversas) return { esperar: "sem_leitura" };
  const comUmaPessoa = (
    (conversas ?? []) as Array<{ status: string | null; assigned_to_user_id: string | null; bot_silenced_until: string | null }>
  ).some(
    (c) =>
      !STATUS_ENCERRADOS.has(c.status ?? "") &&
      (!!c.assigned_to_user_id || silencioVigente(c.bot_silenced_until, agora).vigente),
  );
  if (comUmaPessoa) return { pular: "atendimento_humano" };

  // A passagem a uma pessoa DEPOIS da preparação, em qualquer conversa, mesmo já
  // encerrada (F4i, I03 do cxj): alguém da equipe atendeu a pessoa depois que a
  // campanha a escolheu, e o toque frio chegaria por cima desse atendimento. A
  // conversa encerrada não manda em quem atende agora (o bloco de cima), mas a
  // passagem recente é fato novo. Consulta própria, separada da de cima.
  const { data: passagens, error: erroDasPassagens } = await admin
    .from("conversations")
    .select("last_handoff_at")
    .eq("organization_id", campanha.organization_id)
    .eq("contact_id", alvo.contact_id);
  if (erroDasPassagens) return { esperar: "sem_leitura" };
  const corte = Date.parse(campanha.prepared_at);
  const passouDepois = ((passagens ?? []) as Array<{ last_handoff_at: string | null }>).some(
    (c) => !!c.last_handoff_at && Date.parse(c.last_handoff_at) > corte,
  );
  if (passouDepois) return { pular: "atendimento_humano" };

  if (paradas.length > 0) {
    // A operação marca a parada também no NEGÓCIO; a audiência só olhou o
    // contato. Com funis no público, vale o negócio desses funis: a etiqueta de
    // um negócio de outro funil fala de outro serviço. A SITUAÇÃO do negócio
    // não recorta, de propósito: o negócio costuma ir para `lost` justamente
    // porque a pessoa pediu para parar.
    const funis = textosDoFiltro(campanha.audience_filter, "funis");
    let consulta = admin
      .from("crm_leads")
      .select("tags")
      .eq("organization_id", campanha.organization_id)
      .eq("contact_id", alvo.contact_id);
    if (funis.length > 0) consulta = consulta.in("pipeline_id", funis);
    const { data: negocios, error } = await consulta;
    if (error) return { esperar: "sem_leitura" };
    if (((negocios ?? []) as Array<{ tags: string[] | null }>).some((n) => temParada(n.tags))) {
      return { pular: "etiqueta_de_parada" };
    }
  }

  const escreveu = await escreveuDepoisDe(admin, campanha.organization_id, alvo.contact_id, campanha.prepared_at);
  if (escreveu === null) return { esperar: "sem_leitura" };
  if (escreveu) return { pular: "escreveu_depois_da_preparacao" };
  return null;
}

/** Os estados de quem já saiu: o 1º balão foi, e o ack pode ter avançado o destinatário antes do balão seguinte. */
export const ESTADOS_DE_QUEM_RECEBEU = ["sending", "sent", "delivered", "read"] as const;

/**
 * A conferência final, com tudo relido do banco: a campanha (ainda rodando?), o
 * destinatário (ainda no estado esperado?), os vetos da pessoa e, na
 * prospecção, a fotografia da preparação. `null` = pode mandar.
 *
 * `estadosAceitos`: `["sending"]` antes do 1º balão (a reserva é desta rodada);
 * `ESTADOS_DE_QUEM_RECEBEU` antes dos balões seguintes.
 */
export async function conferenciaFinal(
  admin: SupabaseClient,
  ids: { organizationId: string; campaignId: string; recipientId: string },
  agora: Date,
  estadosAceitos: readonly string[],
): Promise<VetoDaCampanha | null> {
  const { data: lida, error: erroDaCampanha } = await admin
    .from("campaigns")
    .select("id, organization_id, status, base_legal, prepared_at, audience_filter")
    .eq("organization_id", ids.organizationId)
    .eq("id", ids.campaignId)
    .maybeSingle();
  const campanha = lida as (CampanhaDaConferencia & { status: string | null }) | null;
  if (erroDaCampanha || !campanha) return { esperar: "sem_leitura" };
  if (campanha.status !== "running") return { parou: String(campanha.status) };

  const { data, error } = await admin
    .from("campaign_recipients")
    .select(`status, ${COLUNAS_DO_DESTINATARIO}`)
    .eq("campaign_id", ids.campaignId)
    .eq("id", ids.recipientId)
    .maybeSingle();
  const alvo = data as unknown as (DestinatarioRow & { status: string }) | null;
  if (error || !alvo) return { esperar: "sem_leitura" };
  if (!estadosAceitos.includes(alvo.status)) return { parou: "destinatario" };

  const daPessoa = await vetosDaPessoa(admin, campanha, alvo);
  if (daPessoa) return daPessoa;
  return ehProspeccao(campanha) ? travaDaProspeccao(admin, campanha, alvo, agora) : null;
}

/**
 * Desfaz a reserva (`sending`) conforme o veto, e devolve o detalhe da rodada.
 * Só mexe em quem ainda está em `sending`: o ack ou outra rodada podem ter
 * avançado a linha, e escrever por cima a rebaixaria.
 */
export async function aplicarVeto(
  admin: SupabaseClient,
  destinatarioId: string,
  veto: VetoDaCampanha,
  agora: Date,
): Promise<string> {
  if ("parou" in veto && veto.parou === "destinatario") return "destinatario_fora_da_reserva";
  const patch =
    "esperar" in veto
      ? { status: "pending", sending_at: null }
      : "parou" in veto
        ? veto.parou === "cancelled"
          ? { status: "cancelled", cancelled_at: agora.toISOString(), sending_at: null }
          : { status: "pending", sending_at: null }
        : {
            status: statusDaSaida(veto.pular),
            eligibility_status: "excluded",
            exclusion_reason: veto.pular,
            opted_out_at: veto.pular === "opt_out" ? agora.toISOString() : null,
            sending_at: null,
          };
  const { error } = await admin
    .from("campaign_recipients")
    .update(patch)
    .eq("id", destinatarioId)
    .eq("status", "sending");
  if (error) {
    // O destinatário segue reservado (`sending`), e nenhuma rodada o pega de
    // novo: nada sai. O que não pode é a rodada dizer que pulou (F4i).
    logger.error("[campanha] o veto da conferência final não foi gravado", {
      destinatario: destinatarioId,
      veto,
      erro: error.message,
    });
    return "veto_sem_registro";
  }
  if ("esperar" in veto) return `trava:${veto.esperar}`;
  if ("parou" in veto) return "campanha_parou";
  return `pulado:${veto.pular}`;
}
