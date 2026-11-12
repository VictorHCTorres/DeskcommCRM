/**
 * A HORA DA VAGA NO ENVIO DA CAMPANHA (F4t do cxj, 12/11/2026: T01 e T02).
 *
 * A bancada (o PostgREST em memória, o ledger do número, o handler dublê) e o T01 são os do cxj, copiados da cópia da
 * revisão (`lib/campanhas/revisao-cxj-f4t.test.ts`) sem mudar a conta. Mudou só o dublê da reserva: a rodada passa a
 * mandar o RELÓGIO, e não o instante, e o dublê o lê depois da espera, como o store lê sob a trava.
 *
 * T01: a reserva da vaga espera a trava do número, e a espera atravessa as 18h; a rodada chamava o handler mesmo assim.
 * T02: a vaga ficava com o horário de antes da espera. A versão 15 lê o instante sob a trava, confere a janela e a idade
 * da vaga logo depois da reserva e de novo no último passo do handler (`campaignSlot`), e reserva com folga no intervalo.
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

describe('F4t — janela da rodada durante espera da reserva', () => {
  it.each([false, true])('T01 campanha não começa transporte depois das 18h; espera=%s', async (espera) => {
    const inicio = new Date('2026-11-18T20:59:59Z');
    vi.useFakeTimers(); vi.setSystemTime(inicio);
    mundo.knobs = {...mundo.knobs, windowStartHour:9, windowEndHour:18, warmupDailyCaps:[{minAgeDays:0,cap:null}]};
    const {admin} = cenario(campanha('legitimate_interest'), pendente('ana'));
    // Seam da reserva: a rodada real entrega um Date antes da espera. O store real
    // conserva esse Date (teste de banco T02), e o handler não confere janela horária.
    mundo.aoRegistrar = () => { if (espera) vi.setSystemTime(new Date('2026-11-18T21:00:01Z')); };
    const horarios: number[] = [];
    mundo.aoEnviar = async () => { horarios.push(Date.now()); };
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(horarios.length).toBe(espera ? 0 : 1);
    } finally { vi.useRealTimers(); }
  });
});


// ─── Versão 15: os casos meus, na mesma bancada ───────────────────────────────────────────────────────────────────

type Slot = { conferir: () => string | null };
const slotDe = (i = 0) => (mundo.contextos[i] as { campaignSlot?: Slot } | undefined)?.campaignSlot;
const JANELA = { windowStartHour: 9, windowEndHour: 18, warmupDailyCaps: [{ minAgeDays: 0, cap: null }] };

describe("versão 15 — a vaga leva a hora lida sob a trava, e o envio confere a hora até o último passo", () => {
  it("T02 ⭐ a vaga leva o instante lido depois da espera pela trava, e não o `agora` da rodada", async () => {
    const inicio = new Date("2026-11-18T18:00:00Z"); // 15h em São Paulo
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA };
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoRegistrar = () => vi.setSystemTime(new Date(+inicio + 30_000));
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.envios).toHaveLength(1);
      expect((mundo.ledger.get("chip") ?? []).map(Number)).toEqual([+inicio + 30_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("T01 ⭐ a janela fechada depois da reserva: a vaga volta, a pessoa volta à fila, e nada conta como pulado", async () => {
    const inicio = new Date("2026-11-18T20:59:59Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA };
    const { admin, tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoRegistrar = () => vi.setSystemTime(new Date("2026-11-18T21:00:01Z"));
    try {
      const r = await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.envios).toHaveLength(0);
      expect(mundo.ledger.get("chip") ?? []).toEqual([]);
      expect(tabelas.campaign_recipients[0]).toMatchObject({ status: "pending", sending_at: null });
      expect(r).toMatchObject({ enviadas: 0, pulados: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("T01 ⭐ consentimento também: a espera pela trava atravessa as 18h, e o handler não é chamado", async () => {
    const inicio = new Date("2026-11-18T20:59:59Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA };
    const { admin, tabelas } = cenario(campanha("consent"), pendente("ana"));
    mundo.aoRegistrar = () => vi.setSystemTime(new Date("2026-11-18T21:00:01Z"));
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.envios).toHaveLength(0);
      expect(mundo.ledger.get("chip") ?? []).toEqual([]);
      expect(tabelas.campaign_recipients[0]).toMatchObject({ status: "pending" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("⭐ o handler recebe a hora da vaga para conferir no último passo: a janela que fecha durante o handler", async () => {
    const inicio = new Date("2026-11-18T20:59:50Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA };
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const vistos: Array<string | null | undefined> = [];
    mundo.aoEnviar = async () => {
      vistos.push(slotDe(0)?.conferir());
      vi.setSystemTime(new Date("2026-11-18T21:00:00Z")); // 18h em ponto: a janela é [9h, 18h)
      vistos.push(slotDe(0)?.conferir());
    };
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(vistos).toEqual([null, "janela_fechou"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("⭐ e a vaga velha: passada a folga desde a reserva, o último passo do handler não deixa sair", async () => {
    const inicio = new Date("2026-11-18T18:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA };
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const vistos: Array<string | null | undefined> = [];
    mundo.aoEnviar = async () => {
      vistos.push(slotDe(0)?.conferir());
      vi.setSystemTime(new Date(+inicio + FOLGA));
      vistos.push(slotDe(0)?.conferir());
      vi.setSystemTime(new Date(+inicio + FOLGA + 1));
      vistos.push(slotDe(0)?.conferir());
    };
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(vistos).toEqual([null, null, "vaga_vencida"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("⭐ consentimento: o handler também recebe a hora da vaga, sem a entrega da prospecção", async () => {
    const inicio = new Date("2026-11-18T20:59:50Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA };
    const { admin } = cenario(campanha("consent"), pendente("ana"));
    const vistos: Array<string | null | undefined> = [];
    mundo.aoEnviar = async () => {
      vi.setSystemTime(new Date("2026-11-18T21:00:00Z"));
      vistos.push(slotDe(0)?.conferir());
    };
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(vistos).toEqual(["janela_fechou"]);
      expect((mundo.contextos[0] as { campaignDelivery?: unknown }).campaignDelivery).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("⭐ a folga no intervalo: o 1º balão só reserva com o intervalo do número mais a folga da vaga", async () => {
    const inicio = new Date("2026-11-18T18:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA, throttleMs: 5_000 };
    // O último envio do número foi há 6 s: cabe no intervalo de 5 s, mas não no intervalo mais a folga.
    mundo.ledger.set("chip", [new Date(+inicio - 6_000)]);
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.regras[0]?.intervaloMs).toBe(5_000 + FOLGA);
      expect(mundo.envios).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("controle: sem intervalo no número, a reserva não ganha folga, e sai", async () => {
    const inicio = new Date("2026-11-18T18:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA, throttleMs: 0 };
    mundo.ledger.set("chip", [new Date(+inicio - 6_000)]);
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.regras[0]?.intervaloMs).toBe(0);
      expect(mundo.envios).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("⭐ o balão seguinte não para pela janela (a mensagem começou dentro dela), mas para pela vaga velha", async () => {
    const inicio = new Date("2026-11-18T20:59:58Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA };
    const { admin } = cenario(
      campanha("legitimate_interest", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );
    const vistos: Array<string | null | undefined> = [];
    let chamada = 0;
    mundo.aoEnviar = async () => {
      chamada += 1;
      if (chamada === 1) vi.setSystemTime(new Date("2026-11-18T21:00:01Z")); // 18h passou durante o 1º balão
      if (chamada === 2) {
        const slot = slotDe(1);
        vistos.push(slot?.conferir());
        vi.setSystemTime(new Date(Date.now() + FOLGA + 1));
        vistos.push(slot?.conferir());
      }
    };
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.envios).toHaveLength(2);
      expect(vistos).toEqual([null, "vaga_vencida"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Um 2º número, fictício, para quem não pode cair no mesmo telefone da Ana.
const OUTRO = "+" + "55" + "88" + "9".repeat(5) + "0001";

describe("versão 15 — a janela conferida depois da reserva é a mesma que a rodada conferiu antes dela", () => {
  /** A espera pela trava leva o relógio de `de` para `para`; quantas mensagens saem. */
  const atravessa = async (de: string, para: string, c: Linha, knobs: Partial<PacingKnobs>) => {
    const inicio = new Date(de);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, warmupDailyCaps: [{ minAgeDays: 0, cap: null }], ...knobs } as PacingKnobs;
    const { admin } = cenario(c, pendente("ana"));
    mundo.aoRegistrar = () => vi.setSystemTime(new Date(para));
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      return mundo.envios.length;
    } finally {
      vi.useRealTimers();
    }
  };
  // O número aberto o dia inteiro, e a prospecção só de segunda a sexta (0 = domingo).
  const diaInteiro = { windowStartHour: 0, windowEndHour: 24, prospeccaoDias: [1, 2, 3, 4, 5] };

  it("⭐ os dias da prospecção: a espera atravessa a meia-noite de sexta para sábado, e nada sai", async () => {
    // Sexta, 13/11, 23h59min59s em São Paulo; sábado, 0h00min01s.
    expect(await atravessa("2026-11-14T02:59:59Z", "2026-11-14T03:00:01Z", campanha("legitimate_interest"), diaInteiro)).toBe(0);
  });

  it("controle: a mesma espera dentro da sexta sai", async () => {
    expect(await atravessa("2026-11-14T02:59:50Z", "2026-11-14T02:59:52Z", campanha("legitimate_interest"), diaInteiro)).toBe(1);
  });

  it("⭐ o feriado nacional: a espera atravessa a meia-noite de 24 para 25/12, e nada sai", async () => {
    // Quinta, 24/12, 23h59min59s; sexta, 25/12, 0h00min01s: dia de prospecção, mas Natal.
    expect(await atravessa("2026-12-25T02:59:59Z", "2026-12-25T03:00:01Z", campanha("legitimate_interest"), diaInteiro)).toBe(0);
  });

  it("controle: consentimento não lê os dias da prospecção nem o feriado, e o sábado sai, como antes", async () => {
    expect(await atravessa("2026-11-14T02:59:59Z", "2026-11-14T03:00:01Z", campanha("consent"), diaInteiro)).toBe(1);
  });

  it("⭐ a janela da própria campanha (9h às 17h), com a do número aberta até as 18h", async () => {
    // 16h59min59s → 17h00min01s em São Paulo.
    const c = campanha("legitimate_interest", { janela_inicio_hora: 9, janela_fim_hora: 17 });
    expect(await atravessa("2026-11-18T19:59:59Z", "2026-11-18T20:00:01Z", c, { windowStartHour: 9, windowEndHour: 18 })).toBe(0);
  });

  it("⭐ o relógio é o da rodada: a 2ª campanha grava a vaga na hora de verdade, depois da espera da 1ª", async () => {
    const inicio = new Date("2026-11-18T18:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA };
    const { admin, tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
    tabelas.campaigns.push(campanha("legitimate_interest", { id: "camp2", channel_session_id: "chip2" }));
    tabelas.channel_sessions.push({ id: "chip2", organization_id: "org-1", status: "WORKING", daily_message_limit: null });
    tabelas.campaign_recipients.push(
      pendente("bia", ["funil-a"], { campaign_id: "camp2", recipient_address: OUTRO }, { phone_number: OUTRO }),
    );
    // A 1ª campanha leva 30 s no handler; as duas recebem o mesmo `agora` da rodada.
    mundo.aoEnviar = async () => {
      if (mundo.envios.length === 1) vi.setSystemTime(new Date(+inicio + 30_000));
    };
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.envios).toEqual(["conv:ana:chip", "conv:bia:chip2"]);
      expect((mundo.ledger.get("chip2") ?? []).map(Number)).toEqual([+inicio + 30_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("controle: com o intervalo padrão do número (1,2 s), a rodada de um minuto depois manda para a pessoa seguinte", async () => {
    const inicio = new Date("2026-11-18T18:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA, throttleMs: PACING_DEFAULTS.throttleMs };
    const { admin, tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
    tabelas.campaign_recipients.push(pendente("bia", ["funil-a"], { recipient_address: OUTRO }, { phone_number: OUTRO }));
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.envios).toEqual(["conv:ana:chip"]);
      const umMinutoDepois = new Date(+inicio + 60_000);
      vi.setSystemTime(umMinutoDepois);
      await rodarUmaRodadaDeCampanha(admin, umMinutoDepois);
      expect(mundo.envios).toEqual(["conv:ana:chip", "conv:bia:chip"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("versão 16 — a vaga da campanha guarda a hora mais tardia do balão (F4u do cxj, U02)", () => {
  it("⭐ com intervalo no número, cada balão grava a vaga com a folga, e a reserva do 1º segue com o intervalo mais a folga", async () => {
    const inicio = new Date("2026-11-18T18:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA, throttleMs: PACING_DEFAULTS.throttleMs };
    const { admin } = cenario(
      campanha("legitimate_interest", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );
    mundo.aoEnviar = async () => {
      vi.setSystemTime(new Date(Date.now() + 700));
    };
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.envios).toHaveLength(2);
      expect(mundo.folgas).toEqual([FOLGA, FOLGA]);
      expect(mundo.regras.map((r) => r.intervaloMs)).toEqual([PACING_DEFAULTS.throttleMs + FOLGA, 0]);
      expect((mundo.ledger.get("chip") ?? []).map(Number)).toEqual([+inicio + FOLGA, +inicio + 700 + FOLGA]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("⭐ a vaga que volta é procurada com a mesma folga: a janela fecha depois da reserva, e a linha sai do ledger", async () => {
    const inicio = new Date("2026-11-18T20:59:59Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA, throttleMs: 5_000 };
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoRegistrar = () => vi.setSystemTime(new Date("2026-11-18T21:00:01Z"));
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.envios).toHaveLength(0);
      expect(mundo.folgasDevolvidas).toEqual([FOLGA]);
      expect(mundo.ledger.get("chip") ?? []).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("controle: sem intervalo no número, nem a vaga nem a devolução levam folga", async () => {
    const inicio = new Date("2026-11-18T20:59:59Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(inicio);
    mundo.knobs = { ...mundo.knobs, ...JANELA, throttleMs: 0 };
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoRegistrar = () => vi.setSystemTime(new Date("2026-11-18T21:00:01Z"));
    try {
      await rodarUmaRodadaDeCampanha(admin, inicio);
      expect(mundo.folgas).toEqual([0]);
      expect(mundo.folgasDevolvidas).toEqual([0]);
      expect(mundo.ledger.get("chip") ?? []).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
