/**
 * Campanha de texto em vários balões (migration 0765, PR #3329).
 *
 * A divisão é a do AGENTE (`splitForSend`), não uma cópia: o parágrafo é a
 * fronteira do balão nos dois lugares, e duas regras fariam a prévia do
 * operador e o aparelho do cliente discordarem.
 *
 * ═══ Por que no máximo 3 balões ═══
 *
 * A rodada atende as campanhas em série, dentro de um laço que todos os
 * clientes da instalação dividem. Cada pausa entre balões é tempo que a
 * campanha do vizinho espera. Três balões custam duas pausas curtas; o texto
 * que passar disso vai junto no último balão, sem perder nada.
 */
import { splitForSend } from "@/lib/agent-engine/agent/split-message";

export const MAX_BALOES_POR_DESTINATARIO = 3;

/**
 * Os balões de um destinatário. Desligado (ou modelo aprovado, que quem chama
 * passa como `dividir = false`) é sempre um balão só, com o corpo intacto.
 * Sem teto de caracteres: a campanha divide só por parágrafo, que é o que o
 * operador escreveu e o que a tela promete.
 */
export function baloesDaCampanha(
  corpo: string,
  dividir: boolean,
  maxBaloes: number = MAX_BALOES_POR_DESTINATARIO,
): string[] {
  if (!dividir) return [corpo];
  const baloes = splitForSend(corpo, true, Number.POSITIVE_INFINITY, maxBaloes);
  return baloes.length > 0 ? baloes : [corpo];
}

/** A pausa entre balões: o espaçamento anti-ban do número (throttle + jitter), nunca o intervalo da campanha. */
export function pausaEntreBaloes(
  knobs: { throttleMs: number; jitterMaxMs: number },
  rng: () => number = Math.random,
): number {
  return knobs.throttleMs + Math.floor(rng() * knobs.jitterMaxMs);
}

/**
 * Envia os balões em ordem. Cada balão enviado passa por `registrar`, com o
 * índice. A rodada não o usa desde a F4m: ela registra a vaga de cada balão no
 * teto do número ANTES de enviá-lo, dentro do `enviar`, para nenhuma mensagem
 * sair fora da conta do dia (`rodada.ts`); registrar aqui, depois do envio,
 * deixava a mensagem fora do teto quando o banco recusava. Para no primeiro balão `failed` e o devolve como desfecho: mandar o
 * resto depois de uma falha entregaria a mensagem pela metade e fora de ordem.
 *
 * `continuar` (opcional) é perguntado antes de cada balão seguinte, depois da
 * pausa: `false` para ali, e o desfecho é o do último balão que saiu. A
 * prospecção o usa para não mandar o resto a quem respondeu ao começo.
 *
 * `enviar` devolver `null` num balão SEGUINTE é o mesmo `false` do `continuar`,
 * dito de dentro do envio: a conferência final do handler vetou aquele balão
 * (F4i). Ele não saiu, não é registrado, e o desfecho é o do último que saiu. No
 * 1º balão não há "último que saiu", e o laço recusa.
 *
 * `parar` (opcional) é perguntado depois de cada balão: `true` para ali, como a
 * falha, e esse balão é o desfecho. A prospecção o usa para o balão que não
 * saiu: o que o canal segurou na fila física (F4i, A1), porque se o canal
 * voltasse na pausa o seguinte sairia sem ele; e o incerto (F4j, J04), porque o
 * seguinte que saísse viraria o desfecho e esconderia a incerteza.
 */
export async function enviarEmBaloes<T extends { status?: string }>(
  baloes: readonly string[],
  passos: {
    enviar: (corpo: string, indice: number) => Promise<T | null>;
    registrar?: (indice: number) => Promise<void>;
    esperar: () => Promise<void>;
    continuar?: (indice: number) => Promise<boolean>;
    parar?: (desfecho: T) => boolean;
  },
): Promise<{ primeira: T; desfecho: T; indiceDoDesfecho: number }> {
  let primeira: T | undefined;
  let desfecho: T | undefined;
  let indiceDoDesfecho = 0;
  for (let indice = 0; indice < baloes.length; indice++) {
    if (indice > 0) {
      await passos.esperar();
      if (passos.continuar && !(await passos.continuar(indice))) break;
    }
    const resultado = await passos.enviar(baloes[indice]!, indice);
    if (resultado === null) {
      if (indice === 0) throw new Error("enviarEmBaloes: o 1º balão não pode parar sem desfecho");
      break;
    }
    desfecho = resultado;
    indiceDoDesfecho = indice;
    primeira ??= desfecho;
    await passos.registrar?.(indice);
    if (desfecho.status === "failed" || passos.parar?.(desfecho)) break;
  }
  return { primeira: primeira!, desfecho: desfecho!, indiceDoDesfecho };
}
