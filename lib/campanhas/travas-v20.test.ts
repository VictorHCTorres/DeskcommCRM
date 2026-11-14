/**
 * AS TRAVAS DA LINHA A NA v20, na rodada da campanha (sobre a base 1.109).
 *
 * A bancada (o PostgREST em memória, o ledger do número, o handler dublê) é a de `hora-da-vaga-no-envio.test.ts`,
 * copiada sem mudar a conta. O que se prova aqui:
 *  - a janela vem da CONFIGURAÇÃO (campanha e número), e a Linha A abre às 8h00: 8h00 sai, 7h59 e 18h00 não;
 *    a espera pela trava que atravessa as 18h não manda (o último passo confere a hora);
 *  - feriado nacional: 20/11/2026 (Consciência Negra) não manda, e a sobra de quinta 19/11 espera;
 *  - duplicidade: quem já recebeu de outra campanha hoje (pelo contato ou pelo número) não recebe outra;
 *  - a prospecção não sai por transmissão.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { logger } from "@/lib/logger";
import { PACING_DEFAULTS, type PacingKnobs } from "@/lib/agent-engine/pacing/defaults";

const mundo = vi.hoisted(() => ({
  knobs: null as unknown as PacingKnobs,
  ledger: new Map<string, Date[]>(),
  envios: [] as string[],
  contextos: [] as Record<string, unknown>[],
  aoLerKnobs: null as null | (() => void),
  aoAbrir: null as null | (() => void),
  aoDevolver: null as null | (() => void),
  aoRegistrar: null as null | (() => void),
  aoEnviar: null as null | (() => Promise<Record<string, unknown> | void>),
  regras: [] as Array<{ limite: number | null; vagas: number; intervaloMs: number }>,
  // A folga de cada vaga reservada e a de cada devolução (versão 16): a vaga guarda o instante mais a folga.
  folgas: [] as number[],
  folgasDevolvidas: [] as number[],
}));

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => { mundo.aoLerKnobs?.(); return { knobs: mundo.knobs, numberActivatedAt: null }; },
  loadPacingState: async (_pool: unknown, _org: string, sessionId: string) => {
    const envios = mundo.ledger.get(sessionId) ?? [];
    return { lastSentAt: envios.at(-1) ?? null, sentToday: envios.length, numberActivatedAt: null };
  },
  undoSend: async (_pool: unknown, _org: string, sessionId: string, quando: Date, opts?: { folgaMs?: number }) => {
    mundo.aoDevolver?.();
    mundo.folgasDevolvidas.push(opts?.folgaMs ?? 0);
    const linhas = mundo.ledger.get(sessionId) ?? [];
    const i = linhas.findIndex(d => +d === +quando + (opts?.folgaMs ?? 0));
    if (i >= 0) linhas.splice(i, 1);
  },
  // A rodada manda o relógio (versão 15): o dublê o lê depois da espera, como o store o lê sob a trava. Com um
  // instante (a versão 14), ele vale como veio. A linha leva o instante mais a folga (versão 16), como no store.
  reservarVaga: async (_pool: unknown, _org: string, sessionId: string, relogio: Date | (() => Date), regra: {limite:number|null;desde:Date;vagas:number;intervaloMs:number;folgaMs?:number}) => {
    mundo.aoRegistrar?.();
    mundo.regras.push({ limite: regra.limite, vagas: regra.vagas, intervaloMs: regra.intervaloMs });
    mundo.folgas.push(regra.folgaMs ?? 0);
    const quando = typeof relogio === "function" ? relogio() : relogio;
    const linhas = mundo.ledger.get(sessionId) ?? [];
    const ultimo = linhas.length ? Math.max(...linhas.map(Number)) : null;
    if (regra.limite !== null && linhas.filter(d => +d >= +regra.desde).length + regra.vagas > regra.limite) return "teto_cheio";
    if (regra.intervaloMs > 0 && ultimo !== null && +quando - ultimo < regra.intervaloMs) return "intervalo";
    mundo.ledger.set(sessionId, [...linhas, new Date(+quando + (regra.folgaMs ?? 0))]);
    return "reservada";
  },
}));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: async (_admin: unknown, _org: string, contato: string, sessionId: string) => {
    await mundo.aoAbrir?.();
    return {conversation_id: `conv:${contato}:${sessionId}`};
  },
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (_admin: unknown, ctx: { serviceBoundary: { conversation_id: string } }) => {
    mundo.contextos.push(ctx as unknown as Record<string, unknown>);
    mundo.envios.push(ctx.serviceBoundary.conversation_id);
    // F4j: sucesso do dublê exige confirmação; I05 preserva queued explicitamente.
    return (await mundo.aoEnviar?.()) ?? { id: `msg-${mundo.envios.length}`, status: "sent" };
  },
}));

import { ATRASO_MAXIMO_DA_VAGA_DA_CAMPANHA_MS as FOLGA, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]> & Record<"campaigns" | "campaign_recipients" | "channel_sessions" | "messages", Linha[]>;
function globalValor(l: Linha, coluna: string): unknown {
  if (coluna === "organizations.status") return (l.organizations as Linha)?.status;
  const [raiz, chave] = coluna.split("->>");
  const v = chave ? (l[raiz!] as Linha)?.[chave] : l[coluna];
  return chave && v != null ? String(v) : v ?? null;
}

/**
 * PostgREST em memória: `eq`, `in`, `gt`, `gte`, `not is null`, `limit`, `update`, `select`, `maybeSingle`.
 * `depoisDoUpdate(n)` roda depois do n-ésimo `update` resolvido: é onde a corrida com o worker acontece.
 * `falhas`: tabelas cuja leitura devolve erro, como o PostgREST quando o banco cai.
 */
function fakeAdmin(
  tabelas: Tabelas,
  opcoes: { depoisDoUpdate?: (n: number) => Promise<void>; falhas?: readonly string[]; falhaNoPatch?: (t: string, p: Linha) => boolean } = {},
) {
  const { depoisDoUpdate, falhas = [] } = opcoes;
  let updates = 0;
  const de = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let limite = Infinity;
    let patch: Linha | null = null;
    const resolver = async () => {
      if (patch && opcoes.falhaNoPatch?.(tabela, patch)) return {data:null,error:{message:"escrita indisponível"},count:null};
      if (falhas.includes(tabela)) return { data: null, error: { message: `leitura de ${tabela} falhou` }, count: null };
      const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).slice(0, limite);
      if (patch) {
        for (const l of linhas) Object.assign(l, patch);
        updates += 1;
        if (depoisDoUpdate) await depoisDoUpdate(updates);
      }
      return { data: linhas.map((l) => structuredClone(l)), error: null, count: linhas.length };
    };
    const b: Record<string, unknown> = new Proxy(
      {},
      {
        get(_alvo, metodo) {
          switch (metodo) {
            case "then":
              return (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) => resolver().then(ok, falha);
            case "maybeSingle":
              return async () => {
                const r = await resolver();
                return { data: r.data?.[0] ?? null, error: r.error };
              };
            case "update":
              return (p: Linha) => ((patch = p), b);
            case "eq":
              return (coluna: string, valor: unknown) => {
                if (coluna === "organizations.status") filtros.push((l) => (l.organizations as Linha).status === valor);
                else filtros.push((l) => globalValor(l, coluna) === valor);
                return b;
              };
            case "neq":
              return (coluna: string, v: unknown) => (filtros.push((l) => globalValor(l, coluna) != null && globalValor(l, coluna) !== v), b);
            case "is":
              return (coluna: string, v: unknown) => (filtros.push((l) => globalValor(l, coluna) === v), b);
            case "in":
              return (coluna: string, valores: unknown[]) => (filtros.push((l) => valores.includes(l[coluna])), b);
            case "lte":
              return (coluna: string, valor: string) => (filtros.push((l) => String(l[coluna] ?? "") <= valor), b);
            case "gt":
              return (coluna: string, valor: string) => (filtros.push((l) => String(l[coluna] ?? "") > valor), b);
            case "gte":
              return (coluna: string, valor: string) => (filtros.push((l) => String(l[coluna] ?? "") >= valor), b);
            case "not":
              return (coluna: string) => (filtros.push((l) => l[coluna] != null), b);
            case "limit":
              return (n: number) => ((limite = n), b);
            default:
              return () => b;
          }
        },
      },
    );
    return b;
  };
  return { from: de } as never;
}

// Quarta, 18/11/2026, 11h em São Paulo; a campanha foi preparada às 8h.
const PREPARADA = "2026-11-18T11:00:00.000Z";

const campanha = (base: "legitimate_interest" | "consent", mudar: Linha = {}): Linha => ({
  id: "camp",
  organization_id: "org-1",
  channel_session_id: "chip",
  name: "Linha A · 2026-11-18 · toque 2 · chip 5286 · fa-20261118-t2-d0f49ade",
  message_body: "{{lead.msg_2}}",
  content_version: 1,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: null,
  teto_horario: null,
  message_mode: "text",
  velocidade: "gradual",
  split_messages: false,
  status: "running",
  started_at: "2026-11-18T11:55:00.000Z",
  paused_at: null,
  base_legal: base,
  prepared_at: PREPARADA,
  audience_filter: { com_todas_tags: ["fa-20261118-t2-d0f49ade"], sem_tags: ["sair", "parar", "tem-quem-cuide"] },
  organizations: { status: "active" },
  ...mudar,
});

const pendente = (contato: string, tags: string[] = ["funil-a"], mudar: Linha = {}, doContato: Linha = {}): Linha => ({
  id: `r-${contato}`,
  campaign_id: "camp",
  status: "pending",
  sent_at: null,
  contact_id: contato,
  // O número congelado na preparação (`preparacao.ts`: o telefone do candidato elegível).
  recipient_address: ("+" + "55" + "88" + "9".repeat(5) + "0000"),
  rendered_body: "Texto congelado do 2º toque.",
  variables: {},
  contacts: {
    id: contato,
    name: contato,
    display_name: null,
    phone_number: ("+" + "55" + "88" + "9".repeat(5) + "0000"),
    is_blocked: false,
    is_personal: false,
    is_anonymized: false,
    consent: null,
    tags,
    force_human: false,
    is_merged_into: null,
    ...doContato,
  },
  ...mudar,
});

function cenario(
  c: Linha,
  p: Linha,
  mensagens: Linha[] = [],
  extra: { negocios?: Linha[]; falhas?: readonly string[]; falhaNoPatch?: (t: string, p: Linha) => boolean } = {},
) {
  const tabelas: Tabelas = {
    campaigns: [c],
    campaign_recipients: [p],
    campaign_channel_sessions: [],
    channel_sessions: [{ id: "chip", organization_id: "org-1", status: "WORKING", daily_message_limit: null }],
    campaign_suppressions: [],
    messages: mensagens,
    crm_leads: extra.negocios ?? [],
  };
  return { tabelas, admin: fakeAdmin(tabelas, { falhas: extra.falhas }) };
}

beforeEach(() => {
  mundo.knobs = { ...PACING_DEFAULTS, throttleMs: 0, jitterMaxMs: 0 };
  mundo.ledger.clear();
  mundo.envios.length = 0;
  mundo.contextos.length = 0;
  mundo.aoLerKnobs = null;
  mundo.aoEnviar = null;
  mundo.aoAbrir = null;
  mundo.aoRegistrar = null;
  mundo.aoDevolver = null;
  mundo.regras.length = 0;
  mundo.folgas.length = 0;
  mundo.folgasDevolvidas.length = 0;
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.error).mockClear();
  vi.useRealTimers();
});


// ─── v20 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Fortaleza e São Paulo: UTC−3. `local(h, m)` em 18/11/2026 (quarta). */
const em = (dia: string, hhmm: string) => new Date(`${dia}T${hhmm}:00-03:00`);
const JANELA_8_18 = { windowStartHour: 8, windowEndHour: 18, warmupDailyCaps: [{ minAgeDays: 0, cap: null }] };
const CAMPANHA_8_18 = { janela_inicio_hora: 8, janela_fim_hora: 18 };

async function rodarEm(instante: Date, c: Linha, p: Linha, extra: Parameters<typeof cenario>[3] = {}, avancar?: Date) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(instante);
  const montado = cenario(c, p, [], extra);
  if (avancar) mundo.aoRegistrar = () => vi.setSystemTime(avancar);
  try {
    const r = await rodarUmaRodadaDeCampanha(montado.admin, instante);
    return { r, ...montado };
  } finally {
    vi.useRealTimers();
  }
}

describe("v20 · a janela da Linha A abre às 8h00 e vem da configuração", () => {
  it.each([
    ["08:00", 1],
    ["07:59", 0],
    ["18:00", 0],
    ["17:59", 1],
  ] as const)("campanha 8–18 e número 8–18: às %s saem %i", async (hhmm, quantas) => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    await rodarEm(em("2026-11-18", hhmm), campanha("legitimate_interest", CAMPANHA_8_18), pendente("ana"));
    expect(mundo.envios).toHaveLength(quantas);
  });

  it("⭐ a espera pela trava do número atravessa as 18h00: nada sai, a vaga volta e a pessoa volta à fila", async () => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    const { tabelas } = await rodarEm(
      new Date(+em("2026-11-18", "17:59") + 59_000),
      campanha("legitimate_interest", CAMPANHA_8_18),
      pendente("ana"),
      {},
      em("2026-11-18", "18:00"),
    );
    expect(mundo.envios).toHaveLength(0);
    expect(mundo.ledger.get("chip") ?? []).toEqual([]);
    expect(tabelas.campaign_recipients[0]).toMatchObject({ status: "pending" });
  });

  it("⭐ a espera pela trava começa às 7h59 e termina às 8h00: a rodada não reserva fora da janela (nada sai)", async () => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    await rodarEm(em("2026-11-18", "07:59"), campanha("legitimate_interest", CAMPANHA_8_18), pendente("ana"), {}, em("2026-11-18", "08:00"));
    expect(mundo.envios).toHaveLength(0);
  });

  it("controle: a janela do número 9–18 (a de antes) recusa as 8h00 — é a configuração que decide, não o código", async () => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18, windowStartHour: 9 };
    await rodarEm(em("2026-11-18", "08:00"), campanha("legitimate_interest", CAMPANHA_8_18), pendente("ana"));
    expect(mundo.envios).toHaveLength(0);
  });

  it("controle: a janela da campanha 9–18 recusa as 8h00 com o número em 8–18", async () => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    await rodarEm(em("2026-11-18", "08:00"), campanha("legitimate_interest", { janela_inicio_hora: 9, janela_fim_hora: 18 }), pendente("ana"));
    expect(mundo.envios).toHaveLength(0);
  });
});

describe("v20 · feriado nacional: 20/11/2026 (Consciência Negra)", () => {
  it("⭐ a sobra de quinta 19/11 não sai na sexta 20/11, às 8h30: espera a meia-noite seguinte", async () => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    const sobra = pendente("ana", ["funil-a"], { next_attempt_at: "2026-11-19T20:00:00.000Z" });
    const { tabelas } = await rodarEm(em("2026-11-20", "08:30"), campanha("legitimate_interest", CAMPANHA_8_18), sobra);
    expect(mundo.envios).toHaveLength(0);
    expect(mundo.ledger.get("chip") ?? []).toEqual([]);
    const linha = tabelas.campaign_recipients[0]!;
    expect(linha.status).toBe("pending");
    expect(Date.parse(String(linha.next_attempt_at))).toBeGreaterThanOrEqual(+em("2026-11-21", "00:00"));
  });

  it("⭐ nem às 17h59 de 20/11", async () => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    await rodarEm(em("2026-11-20", "17:59"), campanha("legitimate_interest", CAMPANHA_8_18), pendente("ana"));
    expect(mundo.envios).toHaveLength(0);
  });

  it("controle: quinta 19/11 às 8h30 sai", async () => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    await rodarEm(em("2026-11-19", "08:30"), campanha("legitimate_interest", CAMPANHA_8_18), pendente("ana"));
    expect(mundo.envios).toHaveLength(1);
  });
});

describe("v20 · duplicidade: ninguém recebe duas mensagens de prospecção no mesmo dia", () => {
  const outraLinha = (mudar: Linha): Linha => ({
    id: "r-outra",
    campaign_id: "outra-campanha",
    organization_id: "org-1",
    contact_id: "outro-cadastro",
    recipient_address: "+5500000000000",
    status: "sent",
    sending_at: null,
    sent_at: new Date(+em("2026-11-18", "08:05")).toISOString(),
    ...mudar,
  });
  const comA = (linhas: Linha[]) => (t: { tabelas: Tabelas }) => t.tabelas.campaign_recipients.push(...linhas);

  async function rodarComOutra(outra: Linha) {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    vi.useFakeTimers({ toFake: ["Date"] });
    const agora = em("2026-11-18", "10:00");
    vi.setSystemTime(agora);
    const montado = cenario(campanha("legitimate_interest", CAMPANHA_8_18), pendente("ana", ["funil-a"], { organization_id: "org-1" }));
    comA([outra])(montado);
    try {
      await rodarUmaRodadaDeCampanha(montado.admin, agora);
    } finally {
      vi.useRealTimers();
    }
    return montado.tabelas.campaign_recipients[0]!;
  }

  it("⭐ o mesmo contato recebeu hoje por outra campanha: não sai, e o destinatário é excluído com o motivo", async () => {
    const alvo = await rodarComOutra(outraLinha({ contact_id: "ana" }));
    expect(mundo.envios).toHaveLength(0);
    expect(alvo.status).not.toBe("sending");
    expect(alvo.status).not.toBe("sent");
    expect(alvo.exclusion_reason ?? alvo.last_error_code).toBe("recebeu_outra_campanha_hoje");
  });

  it("⭐ um cadastro gêmeo com o mesmo número está saindo agora por outra campanha: não sai", async () => {
    const alvo = await rodarComOutra(
      outraLinha({ recipient_address: "+5588999990000", status: "sending", sent_at: null, sending_at: new Date(+em("2026-11-18", "09:59")).toISOString() }),
    );
    expect(mundo.envios).toHaveLength(0);
    expect(alvo.status).not.toBe("sent");
  });

  it("controle: o mesmo contato recebeu ONTEM: sai", async () => {
    await rodarComOutra(outraLinha({ contact_id: "ana", sent_at: new Date(+em("2026-11-17", "15:00")).toISOString() }));
    expect(mundo.envios).toHaveLength(1);
  });

  it("controle: a outra linha falhou hoje (não recebeu): sai", async () => {
    await rodarComOutra(outraLinha({ contact_id: "ana", status: "failed" }));
    expect(mundo.envios).toHaveLength(1);
  });
});

describe("v20 · a prospecção não sai por transmissão", () => {
  it("⭐ campanha de prospecção em transmissão: pausa com o motivo, e nada sai", async () => {
    mundo.knobs = { ...mundo.knobs, ...JANELA_8_18 };
    const c = campanha("legitimate_interest", { ...CAMPANHA_8_18, velocidade: "transmissao", message_mode: "template" });
    const { tabelas } = await rodarEm(em("2026-11-18", "10:00"), c, pendente("ana"));
    expect(mundo.envios).toHaveLength(0);
    expect(tabelas.campaigns[0]).toMatchObject({ status: "paused", failure_code: "prospeccao_sem_transmissao" });
  });
});
