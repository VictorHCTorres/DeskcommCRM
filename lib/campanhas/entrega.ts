/**
 * A conferência final da campanha DENTRO do handler de mensagens (F4g, A3).
 *
 * A rodada confere a pessoa depois da reserva e de novo logo antes do envio,
 * mas entre essa conferência e o efeito do provedor ainda há o handler inteiro:
 * a resposta, o comando humano, a recusa ou o cancelamento que chegarem ali
 * passavam. O handler já confere a prospecção do agente assim
 * (`assertProspectingDelivery`, no começo e no `checkBoundary`); esta é a mesma
 * régua para a campanha. Vem do contexto do runtime (`HandlerCtx`), nunca do
 * corpo da requisição.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { conferenciaFinal } from "./conferencia";
import type { MotivoDeExclusao } from "./tipos";

/** A entrega de uma campanha de prospecção, como a rodada a passa ao handler (em todo balão, desde a F4i). */
export interface CampaignDelivery {
  organizationId: string;
  campaignId: string;
  recipientId: string;
  /** O número aprovado na preparação (`recipient_address`): o handler manda só para ele. */
  destinoAprovado: string;
  /**
   * Os estados do destinatário em que o envio vale. Sem ele, só `sending` (a reserva desta rodada): é o 1º balão.
   * Nos balões seguintes, `ESTADOS_DE_QUEM_RECEBEU`, porque o ack do 1º pode ter avançado o destinatário (F4i, I01).
   */
  estadosAceitos?: readonly string[];
}

/**
 * Por que a conferência final não deixou sair:
 * - `pular`: um veto da PESSOA (sai da fila com o motivo);
 * - `esperar`: não deu para conferir (volta à fila, falha fechada);
 * - `parou`: a campanha não está mais rodando (o status lido) ou o destinatário saiu da reserva (`destinatario`).
 */
export type VetoDaCampanha =
  | { pular: MotivoDeExclusao }
  | { esperar: "sem_leitura" | "sem_preparacao" }
  | { parou: string };

export class VetoDaCampanhaError extends Error {
  constructor(readonly veto: VetoDaCampanha) {
    super("Envio de campanha vetado na conferência final.");
    this.name = "VetoDaCampanhaError";
  }
}

/** Lança `VetoDaCampanhaError` quando a conferência final não deixa sair; senão, passa. */
export async function assertCampaignDelivery(
  db: SupabaseClient,
  ctx: CampaignDelivery,
  agora: Date = new Date(),
): Promise<void> {
  const veto = await conferenciaFinal(db, ctx, agora, ctx.estadosAceitos ?? ["sending"]);
  if (veto) throw new VetoDaCampanhaError(veto);
}

/** O ator que a rodada dá ao envio de campanha. O envio de teste da tela usa `campaign-test:` e não é envio a lead. */
const ATOR_DA_RODADA = "campaign:";

/**
 * A entrega montada pelo ATOR, quando o envio de campanha chega ao handler sem ela (F4i, H06/H07 do cxj). A rodada
 * passa a entrega em todo balão; esta é a rede para um chamador que a esquecesse, para a conferência final e o destino
 * congelado não dependerem de quem chama. O ator vem do runtime (`HandlerCtx`), nunca do corpo da requisição, e só a
 * rodada cria `campaign:<id>`.
 *
 * - campanha de consentimento: `null`, e o envio segue como antes;
 * - prospecção: a entrega com o número congelado do destinatário (o do `metadata`), aceitando só a reserva
 *   (`sending`): sem saber qual balão é, vale a régua mais estreita;
 * - sem ler a campanha ou o destinatário, ou sem o id dele: `VetoDaCampanhaError` (falha fechada).
 */
export async function entregaPeloAtor(
  db: SupabaseClient,
  ctx: { organization_id: string; actor: { type: string; id?: string | null } },
  metadata: unknown,
): Promise<CampaignDelivery | null> {
  const ator = ctx.actor.type === "webhook_source" ? (ctx.actor.id ?? "") : "";
  if (!ator.startsWith(ATOR_DA_RODADA)) return null;
  const campaignId = ator.slice(ATOR_DA_RODADA.length);
  const { data: campanha, error } = await db
    .from("campaigns")
    .select("base_legal")
    .eq("organization_id", ctx.organization_id)
    .eq("id", campaignId)
    .maybeSingle();
  if (error || !campanha) throw new VetoDaCampanhaError({ esperar: "sem_leitura" });
  if ((campanha as { base_legal: string | null }).base_legal === "consent") return null;
  const recipientId = (metadata as { campaign_recipient_id?: unknown } | null | undefined)?.campaign_recipient_id;
  if (typeof recipientId !== "string" || recipientId === "") throw new VetoDaCampanhaError({ esperar: "sem_leitura" });
  const { data: destinatario, error: erroDoDestinatario } = await db
    .from("campaign_recipients")
    .select("recipient_address")
    .eq("campaign_id", campaignId)
    .eq("id", recipientId)
    .maybeSingle();
  if (erroDoDestinatario || !destinatario) throw new VetoDaCampanhaError({ esperar: "sem_leitura" });
  return {
    organizationId: ctx.organization_id,
    campaignId,
    recipientId,
    destinoAprovado: ((destinatario as { recipient_address: string | null }).recipient_address ?? "").trim(),
  };
}
