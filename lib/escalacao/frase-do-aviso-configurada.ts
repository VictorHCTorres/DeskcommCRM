/**
 * A FRASE DO AVISO DE PASSAGEM, QUANDO O AGENTE TEM A DELE.
 *
 * ## Por que existe (issue #3725)
 *
 * O aviso que o cliente lê quando a IA sai de campo era uma frase FIXA do
 * código — e a escolhida para o motivo genérico era "Prefiro não arriscar aqui:
 * passei seu pedido para um atendente humano." O autor mediu o tamanho do
 * descompasso: o prompt do agente pede tom caloroso, curto, sem frase técnica,
 * e o cliente recebia isso no meio de uma conversa de venda. Texto de marca é
 * do tenant; texto de sistema não deveria ser imutável.
 *
 * ## Onde ele mora, e por que aqui
 *
 * `ai_agents.config` — o JSON que a tela do agente já grava e já lê. SEM
 * MIGRATION: o campo é livre por definição, e uma coluna nova obrigaria todo
 * clone a migrar antes de poder personalizar uma frase.
 *
 * Chave: `aviso_de_handoff`. Duas irmãs são aceitas por compatibilidade com
 * configurações escritas à mão antes desta issue: `aviso_de_passagem` e
 * `handoff_notice`. A PRIMEIRA que existir e for válida vence.
 *
 * ## Validação — o que NÃO é frase configurada
 *
 * Devolver `null` é a resposta para tudo que não serve, e quem chama cai no
 * texto padrão (curto e humano). Isso vale para: tipo errado, string vazia,
 * frase acima do teto (o aviso é UMA mensagem de WhatsApp, não um parágrafo) e
 * frase que fica só de pontuação. Não se valida "tom" aqui — isso é do tenant.
 *
 * ⚠️ A frase configurada SUBSTITUI o aviso inteiro, inclusive o fecho que
 * respeita a disponibilidade da equipe (`textoDoAviso`). A troca é consciente:
 * quem escreve a própria frase assume o que ela promete. Prometer "já te
 * chamam" para uma conta sem ninguém configurado é decisão de quem escreveu —
 * e é justamente por isso que o padrão do produto não promete.
 */

/** Teto do aviso: uma bolha de WhatsApp, não um parágrafo. */
export const TETO_DA_FRASE_DO_AVISO = 320;

/** As chaves aceitas em `ai_agents.config`, na ordem de precedência. */
export const CHAVES_DA_FRASE_DO_AVISO = [
  "aviso_de_handoff",
  "aviso_de_passagem",
  "handoff_notice",
] as const;

/**
 * Lê a frase configurada do agente. `config` é o JSON cru de
 * `ai_agents.config` (`unknown` de propósito: o formato é do banco, e um tipo
 * aqui obrigaria a interface do agente a carregar o campo inteiro).
 */
export function lerFraseDoAvisoConfigurada(config: unknown, agora: Date = new Date()): string | null {
  if (config === null || typeof config !== "object") return null;
  const bruto = config as Record<string, unknown>;
  for (const chave of CHAVES_DA_FRASE_DO_AVISO) {
    const valor = bruto[chave];
    if (typeof valor !== "string") continue;
    const frase = normalizarFraseDoAviso(valor);
    if (frase !== null) return comComplementoForaDoHorario(frase, bruto, agora);
  }
  return null;
}

/**
 * ─── O COMPLEMENTO FORA DO HORÁRIO (1.110.2) ─────────────────────────────────
 *
 * "Já passei para o Victor; ele te responde por aqui." é verdade às 10h de uma
 * terça e é promessa quebrada às 21h de sexta. A frase configurada é fixa — e
 * quem a escreveu assumiu o que ela promete —, então o tenant ganha uma segunda
 * frase, opcional, que só é ACRESCENTADA fora do horário de atendimento humano:
 * "Ele te responde no próximo dia útil, a partir das 8h."
 *
 * Chaves em `ai_agents.config`, as duas opcionais e AUSENTES por padrão (sem a
 * primeira, nada muda para ninguém):
 *
 *   - `aviso_de_handoff_fora_do_horario`: a frase acrescentada;
 *   - `aviso_de_handoff_expediente`: `{ fuso, dias, inicio, fim }` — quando há
 *     gente. Ausente ou torto, vale segunda a sexta, 8h às 18h, em
 *     `America/Sao_Paulo`. `dias` usa 0 = domingo … 6 = sábado.
 *
 * Só existe COM a frase própria: o aviso padrão do produto já tem o fecho de
 * disponibilidade dele (`textoDoAviso`). Feriado não é considerado.
 *
 * ponytail: se as duas juntas passam do teto, sai só a frase — `textoDoAviso`
 * revalida o tamanho, e estourar lá derrubaria a frase do tenant inteira.
 */
export const CHAVE_DO_COMPLEMENTO_FORA_DO_HORARIO = "aviso_de_handoff_fora_do_horario";
export const CHAVE_DO_EXPEDIENTE_DO_AVISO = "aviso_de_handoff_expediente";

export type ExpedienteDoAviso = { fuso: string; dias: readonly number[]; inicio: string; fim: string };

export const EXPEDIENTE_PADRAO_DO_AVISO: ExpedienteDoAviso = {
  fuso: "America/Sao_Paulo",
  dias: [1, 2, 3, 4, 5],
  inicio: "08:00",
  fim: "18:00",
};

const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/u;
const minutos = (hhmm: string): number | null => {
  const m = HORA.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** O expediente configurado, campo a campo: o que vier torto cai no padrão daquele campo. */
export function lerExpedienteDoAviso(valor: unknown): ExpedienteDoAviso {
  if (valor === null || typeof valor !== "object" || Array.isArray(valor)) return EXPEDIENTE_PADRAO_DO_AVISO;
  const v = valor as Record<string, unknown>;
  const dias = Array.isArray(v.dias) && v.dias.length > 0 && v.dias.every((d) => Number.isInteger(d) && (d as number) >= 0 && (d as number) <= 6)
    ? (v.dias as number[])
    : EXPEDIENTE_PADRAO_DO_AVISO.dias;
  const hora = (x: unknown, padrao: string): string => (typeof x === "string" && HORA.test(x) ? x : padrao);
  let fuso = EXPEDIENTE_PADRAO_DO_AVISO.fuso;
  if (typeof v.fuso === "string" && v.fuso !== "") {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: v.fuso });
      fuso = v.fuso;
    } catch {
      // fuso inexistente: fica o padrão
    }
  }
  return { fuso, dias, inicio: hora(v.inicio, EXPEDIENTE_PADRAO_DO_AVISO.inicio), fim: hora(v.fim, EXPEDIENTE_PADRAO_DO_AVISO.fim) };
}

const DIAS_DA_SEMANA: Readonly<Record<string, number>> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** `agora` cai no expediente? O início entra, o fim não (18h00 já é fora). */
export function dentroDoExpedienteDoAviso(agora: Date, expediente: ExpedienteDoAviso): boolean {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: expediente.fuso, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(agora);
  const parte = (tipo: string): string => partes.find((p) => p.type === tipo)?.value ?? "";
  const dia = DIAS_DA_SEMANA[parte("weekday")];
  const agoraMin = Number(parte("hour")) * 60 + Number(parte("minute"));
  const inicio = minutos(expediente.inicio);
  const fim = minutos(expediente.fim);
  if (dia === undefined || inicio === null || fim === null || Number.isNaN(agoraMin)) return true;
  return expediente.dias.includes(dia) && agoraMin >= inicio && agoraMin < fim;
}

function comComplementoForaDoHorario(frase: string, config: Record<string, unknown>, agora: Date): string {
  const bruto = config[CHAVE_DO_COMPLEMENTO_FORA_DO_HORARIO];
  if (typeof bruto !== "string") return frase;
  const complemento = normalizarFraseDoAviso(bruto);
  if (complemento === null) return frase;
  if (dentroDoExpedienteDoAviso(agora, lerExpedienteDoAviso(config[CHAVE_DO_EXPEDIENTE_DO_AVISO]))) return frase;
  const junta = `${frase} ${complemento}`;
  return junta.length <= TETO_DA_FRASE_DO_AVISO ? junta : frase;
}

/**
 * Espaços colapsados e bordas aparadas: a frase vai para o cliente como UMA
 * linha, e uma quebra de linha colada do JSON apareceria como bolha vazia.
 * `null` quando o resultado não tem letra nem número ou passa do teto.
 */
export function normalizarFraseDoAviso(bruta: string): string | null {
  const frase = bruta.replace(/\s+/g, " ").trim();
  if (frase.length < 3 || frase.length > TETO_DA_FRASE_DO_AVISO) return null;
  if (!/[\p{L}\p{N}]/u.test(frase)) return null;
  return frase;
}
