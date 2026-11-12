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
 * A ORDEM (versão 18, F4w do cxj, W02). A resposta mais velha do que a folga no último passo do handler fica na fila, e
 * quem a manda depois é o resgate do watchdog, quando o job dela termina (ou a nova tentativa do job, se ele falhar por
 * outra razão). O turno segue, e a resposta seguinte, com outro registro, saía na hora: a retida chegava depois dela. Agora a saída leva a ordem (`OrdemDaSaidaDoAgente`):
 * se o envio responde a quem escreveu, e a pergunta “há, nesta conversa, uma resposta do agente retida e mais antiga do
 * que esta mensagem?” (`lib/agent-engine/pacing/resposta-retida.ts`). O handler a faz para toda mensagem de texto do
 * envio, em cada corte, antes da conta da idade; havendo, a mensagem não sai: fica na fila, com o motivo
 * `atras_de_resposta_retida`, e sai depois da mais antiga. Para isso a saída é lida no escopo sem ser tomada
 * (`saidaDoAgenteNoEscopo`): a idade é só da 1ª mensagem física, e a ordem é de todas as de texto.
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

/**
 * O motivo da mensagem de texto do agente que não saiu porque há, na conversa, uma resposta retida e mais antiga
 * (versão 18): ela fica na fila, e sai depois da mais antiga.
 */
export const MOTIVO_DA_SAIDA_ATRAS_DE_RETIDA = "atras_de_resposta_retida";

/** Os motivos com que a cadeia do agente retém uma mensagem na fila: a idade, e a ordem. */
export const MOTIVOS_DA_SAIDA_RETIDA = [MOTIVO_DA_SAIDA_VENCIDA, MOTIVO_DA_SAIDA_ATRAS_DE_RETIDA] as const;

/**
 * A marca da resposta retida, em `messages.metadata`: a mensagem retida que responde a quem escreveu a leva, e é ela
 * que segura as seguintes da conversa. O handler a grava; a pergunta da ordem a lê.
 */
export const MARCA_DE_RESPOSTA_RETIDA = "queued_resposta";

/** A ordem que a saída do agente leva até o handler (versão 18, F4w do cxj, W02). */
export interface OrdemDaSaidaDoAgente {
  /**
   * O envio responde a quem escreveu. A resposta retida leva a marca (`MARCA_DE_RESPOSTA_RETIDA`), e é ela que segura
   * as mensagens seguintes da conversa: o envio que não é resposta (com teto do dia e janela) não segura ninguém.
   */
  readonly resposta: boolean;
  /**
   * Há, nesta conversa, uma resposta do agente retida e mais antiga do que esta mensagem? Quem cria a saída diz como
   * se lê (a cadeia lê o banco: `haRespostaRetidaAntes`). Se a leitura falhar, lança, e a mensagem não sai.
   */
  readonly haRespostaRetidaAntes: (mensagem: { conversationId: string; messageId: string }) => Promise<boolean>;
}

/** A saída do agente que o transporte carrega no escopo. */
export interface SaidaDoAgente {
  /** O instante do registro, lido sob a trava do número, depois da espera do intervalo. */
  readonly instante: Date;
  /** A folga: a linha fica em `instante + folgaMs` enquanto o transporte está em curso. */
  readonly folgaMs: number;
  /** O relógio da cadeia (`RunBeforeSendArgs.relogio`). */
  readonly relogio: () => Date;
  /** A ordem (versão 18); `null` quando quem criou a saída não a deu: o handler não pergunta nada, como na versão 17. */
  readonly ordem: OrdemDaSaidaDoAgente | null;
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

/**
 * Há uma resposta do agente retida e mais antiga na conversa: a mensagem de texto não sai agora. Quem a pega a deixa na
 * fila, com o motivo, para sair depois da mais antiga.
 */
export class SaidaAtrasDeRespostaRetidaError extends Error {
  constructor() {
    super(MOTIVO_DA_SAIDA_ATRAS_DE_RETIDA);
    this.name = "SaidaAtrasDeRespostaRetidaError";
  }
}

export function novaSaidaDoAgente(
  instante: Date,
  folgaMs: number,
  relogio: () => Date,
  ordem: OrdemDaSaidaDoAgente | null = null,
): SaidaDoAgente {
  return { instante, folgaMs, relogio, ordem, tomada: false };
}

const escopo = new AsyncLocalStorage<SaidaDoAgente>();

/** Roda o transporte com a saída no escopo: o handler a lê em `tomarSaidaDoAgente`. */
export function comSaidaDoAgente<T>(saida: SaidaDoAgente, transporte: () => Promise<T>): Promise<T> {
  return escopo.run(saida, transporte);
}

/**
 * A saída do escopo, lida sem ser tomada; `null` fora do escopo do agente. É por ela que a ordem chega a todas as
 * mensagens físicas do envio (versão 18): a 2ª bolha não confere a idade, mas confere a ordem.
 */
export function saidaDoAgenteNoEscopo(): SaidaDoAgente | null {
  return escopo.getStore() ?? null;
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
