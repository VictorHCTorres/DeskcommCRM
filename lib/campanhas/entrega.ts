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

/** A entrega de uma campanha de prospecção, como a rodada a passa ao handler (só no 1º balão). */
export interface CampaignDelivery {
  organizationId: string;
  campaignId: string;
  recipientId: string;
  /** O número aprovado na preparação (`recipient_address`): o handler manda só para ele. */
  destinoAprovado: string;
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
  const veto = await conferenciaFinal(db, ctx, agora, ["sending"]);
  if (veto) throw new VetoDaCampanhaError(veto);
}
