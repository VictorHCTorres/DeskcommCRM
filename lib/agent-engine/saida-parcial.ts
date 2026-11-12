/**
 * A marca de um envio COMPOSTO (bolhas, fotos do produto), que devolve o desfecho da ÚLTIMA
 * mensagem física e para no primeiro que não é de sucesso: uma mensagem anterior DESTA chamada
 * saiu, e a última não (F4q). O `kind` segue o da última, que é o que os chamadores leem; quem
 * conta a saída no limite diário do número (`runBeforeSend`) trata a marca como saída.
 *
 * Módulo sem import nenhum, de propósito: `split-message.ts` o importa, e os testes das bolhas
 * seguem no projeto `cercas` (`vitest.cercas.ts`), que só aceita cadeias de import puras.
 */
export interface MarcaDeSaidaParcial {
  saiuEmParte?: boolean;
}

/** Algo saiu nesta chamada: a última mensagem física (`sent`) ou uma anterior (`saiuEmParte`). */
export function saiuAlgo(desfecho: { kind: string } & MarcaDeSaidaParcial): boolean {
  return desfecho.kind === 'sent' || desfecho.saiuEmParte === true;
}

/**
 * O desfecho de um envio composto: o da última mensagem física, com a marca quando uma anterior
 * saiu e ela não. A marca que já vem de dentro (bolhas dentro das fotos) é mantida.
 */
export function comSaidaParcial<T extends { kind: string } & MarcaDeSaidaParcial>(ultimo: T, anteriorSaiu: boolean): T {
  if (!anteriorSaiu || saiuAlgo(ultimo)) return ultimo;
  return { ...ultimo, saiuEmParte: true };
}
