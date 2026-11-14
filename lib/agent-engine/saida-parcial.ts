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

/**
 * Os erros que subiram de um envio composto DEPOIS de uma mensagem física desta chamada sair (F4q
 * do cxj, Q01): a organização parou entre uma bolha e outra, ou entre as fotos, e o handler barrou
 * a seguinte com `OrgNaoOperanteError`. O erro sobe o MESMO objeto — quem chama segue lendo a
 * classe, e a organização parada encerra o job —, e a marca fica guardada aqui, fora dele.
 *
 * A marca é do objeto: um erro reaproveitado entre chamadas a levaria adiante, e o lado errado
 * seria contar uma saída a mais, nunca a menos.
 */
const errosQueSairamEmParte = new WeakSet<object>();

/**
 * O erro de um envio composto, marcado quando uma mensagem anterior desta chamada saiu. Devolve o
 * mesmo valor, para o `throw` de quem chama; a marca que já vem de dentro (as bolhas do texto,
 * nas fotos) se mantém. O que não é objeto não tem onde levar a marca, e sobe como veio.
 */
export function erroComSaidaParcial(erro: unknown, anteriorSaiu: boolean): unknown {
  if (anteriorSaiu && typeof erro === 'object' && erro !== null) errosQueSairamEmParte.add(erro);
  return erro;
}

/** O erro subiu de um envio composto depois de uma mensagem física da mesma chamada sair. */
export function erroSaiuEmParte(erro: unknown): boolean {
  return typeof erro === 'object' && erro !== null && errosQueSairamEmParte.has(erro);
}
