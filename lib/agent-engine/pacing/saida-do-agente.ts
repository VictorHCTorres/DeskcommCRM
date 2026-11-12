/**
 * A SAÍDA DO AGENTE, DO REGISTRO AO PROVEDOR (F4v do cxj, 12/11/2026, V01; versão 17).
 *
 * A cadeia do agente (`runBeforeSend`) grava o registro da saída no limite do número sob a trava dele e confirma a
 * linha antes do transporte (F4p do cxj). O transporte vem depois, sem a trava: o handler grava a mensagem, confere a
 * fronteira e só então chama o provedor. Em produção, esse caminho leva de 2 s a 8 s (leitura de 12/11/2026). A hora
 * do registro ficava para trás, e quem media o intervalo dela (o resgate, a campanha, a resposta seguinte) podia sair
 * a menos do intervalo da saída de verdade.
 *
 * Agora a saída do agente segue a regra da vaga da campanha e da do resgate:
 *
 * - enquanto o transporte está em curso, a linha guarda a hora mais tardia em que a mensagem chega ao provedor: o
 *   instante do registro mais a folga;
 * - a idade é conferida logo antes do transporte, na cadeia, e de novo no último passo do handler, sem espera nenhuma
 *   entre a conta e o provedor; mais velha do que a folga, a mensagem não sai;
 * - confirmado o transporte, a linha vai para a hora em que ele voltou (nunca antes da saída de verdade): quase sempre
 *   recua, e a resposta seguinte não paga a folga de uma saída que já aconteceu; se a chamada ao provedor passou da
 *   hora mais tardia, avança até a hora em que ela voltou.
 *
 * O transporte roda com a saída num escopo assíncrono (`AsyncLocalStorage`), como a fronteira do atendimento
 * (`lib/atendimento/fronteira-server.ts`): o handler a lê sem que os fechamentos de envio dos chamadores mudem de
 * assinatura. Só a 1ª mensagem física do envio a toma: a idade se mede na 1ª. As bolhas e as fotos seguintes do mesmo
 * envio saem com o espaçamento delas, sem conferência (o limite do envio composto), e a linha vai para a hora em que o
 * envio inteiro voltou.
 *
 * Módulo sem import do projeto, para o handler e a cadeia o lerem sem ciclo.
 */
import { AsyncLocalStorage } from "node:async_hooks";

/**
 * A folga da saída do agente: o tempo máximo entre o instante do registro, lido sob a trava do número, e o último
 * passo antes do provedor. É a da vaga da campanha (`ATRASO_MAXIMO_DA_VAGA_DA_CAMPANHA_MS`): o caminho é o mesmo
 * handler. Na leitura de produção de 12/11/2026, o caminho inteiro, com a chamada ao provedor, levou no máximo 8,2 s.
 */
export const ATRASO_MAXIMO_DA_SAIDA_DO_AGENTE_MS = 10_000;

/** O motivo gravado na mensagem que fica na fila (`metadata.queued_reason`) e no desfecho da cadeia. */
export const MOTIVO_DA_SAIDA_VENCIDA = "saida_do_agente_vencida";

/** A saída do agente que o transporte carrega no escopo. */
export interface SaidaDoAgente {
  /** O instante do registro, lido sob a trava do número, depois da espera do intervalo. */
  readonly instante: Date;
  /** A folga: a linha fica em `instante + folgaMs` enquanto o transporte está em curso. */
  readonly folgaMs: number;
  /** O relógio da cadeia (`RunBeforeSendArgs.relogio`). */
  readonly relogio: () => Date;
  /** A 1ª mensagem física do envio já a tomou. */
  tomada: boolean;
}

/** A saída mais velha do que a folga: a mensagem não sai. Quem a pega decide o desfecho (fila ou nova tentativa). */
export class SaidaDoAgenteVencidaError extends Error {
  constructor(readonly idadeMs: number) {
    super(MOTIVO_DA_SAIDA_VENCIDA);
    this.name = "SaidaDoAgenteVencidaError";
  }
}

export function novaSaidaDoAgente(instante: Date, folgaMs: number, relogio: () => Date): SaidaDoAgente {
  return { instante, folgaMs, relogio, tomada: false };
}

const escopo = new AsyncLocalStorage<SaidaDoAgente>();

/** Roda o transporte com a saída no escopo: o handler a lê em `tomarSaidaDoAgente`. */
export function comSaidaDoAgente<T>(saida: SaidaDoAgente, transporte: () => Promise<T>): Promise<T> {
  return escopo.run(saida, transporte);
}

/**
 * A saída do escopo, para a 1ª mensagem física do envio; `null` fora do escopo do agente, ou quando outra mensagem
 * física do mesmo envio já a tomou.
 */
export function tomarSaidaDoAgente(): SaidaDoAgente | null {
  const saida = escopo.getStore();
  if (!saida || saida.tomada) return null;
  saida.tomada = true;
  return saida;
}

/**
 * Confere a idade da saída, agora: mais velha do que a folga, lança. Sem espera nenhuma: quem chama põe a conta logo
 * antes do efeito.
 */
export function conferirSaidaDoAgente(saida: SaidaDoAgente): void {
  const idadeMs = saida.relogio().getTime() - saida.instante.getTime();
  if (idadeMs > saida.folgaMs) throw new SaidaDoAgenteVencidaError(idadeMs);
}
