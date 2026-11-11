/**
 * As travas da campanha de PROSPECÇÃO (base legal de legítimo interesse: abordagem fria, com LIA).
 *
 * Três furos achados na revisão da Linha A (Suindara, 11/11/2026), todos da hora do ENVIO:
 *
 * 1. Quem escreveu depois da preparação continuava na fila: a resposta só fecha o destinatário que já
 *    recebeu (`resposta.ts`), e a revalidação por pessoa da rodada não olhava conversa nem etiqueta de
 *    parada. A pessoa que respondeu ao 1º toque às 9h10 recebia o 2º às 9h15.
 * 2. Cancelar não era atômico: a campanha caía num `update` e a fila em outro, e o worker que já tinha
 *    escolhido o pendente o reservava no meio (a reserva só confere o status do destinatário).
 * 3. A campanha não sabia dia da semana nem feriado: a sobra de quinta saía no feriado de sexta, às 9h.
 *
 * Campanha de consentimento (base `consent`) segue como antes: as travas são da abordagem fria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PACING_DEFAULTS, type PacingKnobs } from "@/lib/agent-engine/pacing/defaults";

const mundo = vi.hoisted(() => ({
  knobs: null as unknown as PacingKnobs,
  ledger: new Map<string, Date[]>(),
  envios: [] as string[],
}));

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => ({ knobs: mundo.knobs, numberActivatedAt: null }),
  loadPacingState: async (_pool: unknown, _org: string, sessionId: string) => {
    const envios = mundo.ledger.get(sessionId) ?? [];
    return { lastSentAt: envios.at(-1) ?? null, sentToday: envios.length, numberActivatedAt: null };
  },
  recordSend: async (_pool: unknown, _org: string, sessionId: string, quando: Date) => {
    mundo.ledger.set(sessionId, [...(mundo.ledger.get(sessionId) ?? []), quando]);
  },
}));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: async (_admin: unknown, _org: string, contato: string, sessionId: string) => ({
    conversation_id: `conv:${contato}:${sessionId}`,
  }),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (_admin: unknown, ctx: { serviceBoundary: { conversation_id: string } }) => {
    mundo.envios.push(ctx.serviceBoundary.conversation_id);
    return { id: `msg-${mundo.envios.length}`, status: "queued" };
  },
}));

import { cancelarAcao } from "@/lib/campanhas/acoes";
import { reservarDestinatario, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]>;

/** A única linha que o cenário monta numa tabela (os testes montam uma campanha e um destinatário). */
function unica(tabelas: Tabelas, tabela: string): Linha {
  const linha = tabelas[tabela]?.[0];
  if (!linha) throw new Error(`o cenário não montou ${tabela}`);
  return linha;
}

/**
 * PostgREST em memória: `eq`, `in`, `gt`, `gte`, `not is null`, `limit`, `update`, `select`, `maybeSingle`.
 * `depoisDoUpdate(n)` roda depois do n-ésimo `update` resolvido: é onde a corrida com o worker acontece.
 * `falhas`: tabelas cuja leitura devolve erro, como o PostgREST quando o banco cai.
 */
function fakeAdmin(
  tabelas: Tabelas,
  opcoes: { depoisDoUpdate?: (n: number) => Promise<void>; falhas?: readonly string[] } = {},
) {
  const { depoisDoUpdate, falhas = [] } = opcoes;
  let updates = 0;
  const de = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let limite = Infinity;
    let patch: Linha | null = null;
    const resolver = async () => {
      if (falhas.includes(tabela)) return { data: null, error: { message: `leitura de ${tabela} falhou` }, count: null };
      const linhas = (tabelas[tabela] ?? []).filter((l) => filtros.every((f) => f(l))).slice(0, limite);
      if (patch) {
        for (const l of linhas) Object.assign(l, patch);
        updates += 1;
        if (depoisDoUpdate) await depoisDoUpdate(updates);
      }
      return { data: linhas.map((l) => ({ ...l })), error: null, count: linhas.length };
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
                else filtros.push((l) => l[coluna] === valor);
                return b;
              };
            case "in":
              return (coluna: string, valores: unknown[]) => (filtros.push((l) => valores.includes(l[coluna])), b);
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
const QUARTA = new Date("2026-11-18T14:00:00.000Z");
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
  recipient_address: "+5588999990000",
  rendered_body: "Texto congelado do 2º toque.",
  variables: {},
  contacts: {
    id: contato,
    name: contato,
    display_name: null,
    phone_number: "+5588999990000",
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

const negocio = (contato: string, tags: string[]): Linha => ({ organization_id: "org-1", contact_id: contato, tags });

const mensagem = (direcao: "inbound" | "outbound", quando: string): Linha => ({
  organization_id: "org-1",
  contact_id: "ana",
  direction: direcao,
  created_at: quando,
});

function cenario(
  c: Linha,
  p: Linha,
  mensagens: Linha[] = [],
  extra: { negocios?: Linha[]; falhas?: readonly string[] } = {},
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
});

describe("1. prospecção: quem escreveu depois da preparação ou pediu para parar sai da fila", () => {
  it("⭐ escreveu às 9h30, depois da preparação das 8h: não recebe, e o destinatário é pulado com o motivo", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [
      mensagem("inbound", "2026-11-18T12:30:00.000Z"),
    ]);
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(r.enviadas).toBe(0);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "skipped",
      eligibility_status: "excluded",
      exclusion_reason: "escreveu_depois_da_preparacao",
    });
  });

  it("controle: escreveu ontem, antes da preparação (a conferência do plano já viu), recebe", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [
      mensagem("inbound", "2026-11-17T18:00:00.000Z"),
    ]);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("controle: mensagem NOSSA depois da preparação não conta como resposta", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [
      mensagem("outbound", "2026-11-18T12:30:00.000Z"),
    ]);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("⭐ ganhou a etiqueta de parada depois da preparação: não recebe", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a", "tem-quem-cuide"]));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "etiqueta_de_parada" });
  });

  it("controle: etiqueta que não é de parada não tira ninguém", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a", "serv:A3"]));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("controle: campanha de consentimento segue como antes, mesmo com resposta depois da preparação", async () => {
    const { admin } = cenario(campanha("consent"), pendente("ana"), [mensagem("inbound", "2026-11-18T12:30:00.000Z")]);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("⭐ a etiqueta de parada foi posta no NEGÓCIO, não no contato: não recebe", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      negocios: [negocio("ana", ["prospeccao", "tem-quem-cuide"])],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "etiqueta_de_parada" });
  });

  it("controle: a etiqueta de parada no negócio de OUTRA pessoa não tira ninguém", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      negocios: [negocio("bia", ["tem-quem-cuide"]), negocio("ana", ["prospeccao"])],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("⭐ o contato foi travado para atendimento humano: não recebe", async () => {
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], {}, { force_human: true }),
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "atendimento_humano" });
  });

  it("⭐ o contato foi mesclado em outro depois da preparação: não recebe", async () => {
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], {}, { is_merged_into: "outro-contato" }),
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "contato_mesclado" });
  });

  it("⭐ o telefone do contato mudou depois da preparação: não recebe", async () => {
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], {}, { phone_number: "+5588911112222" }),
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "destino_mudou" });
  });

  it("controle: o mesmo número escrito de outro jeito não conta como troca", async () => {
    const { admin } = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], { recipient_address: "+55 (88) 99999-0000" }),
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it.each(["messages", "crm_leads"])(
    "⭐ a leitura de %s falhou: não manda (falha fechada) e o destinatário continua pendente",
    async (tabela) => {
      const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], { falhas: [tabela] });
      const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
      expect(mundo.envios).toEqual([]);
      expect(r.detalhe).toContain("trava:sem_leitura");
      expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
    },
  );
});

describe("3. prospecção: dias do número e feriado nacional", () => {
  const SABADO = new Date("2026-11-14T14:00:00.000Z");
  const QUINTA = new Date("2026-11-19T14:00:00.000Z");
  const FERIADO = new Date("2026-11-20T14:00:00.000Z"); // Consciência Negra (Lei 14.759/2023), sexta

  it("⭐ o número prospecta de segunda a sexta: no sábado, a campanha de prospecção não manda", async () => {
    mundo.knobs = { ...mundo.knobs, prospeccaoDias: [1, 2, 3, 4, 5] };
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    await rodarUmaRodadaDeCampanha(admin, SABADO);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
  });

  it("controle: na quarta, manda", async () => {
    mundo.knobs = { ...mundo.knobs, prospeccaoDias: [1, 2, 3, 4, 5] };
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("controle: campanha de consentimento manda no sábado, como antes", async () => {
    mundo.knobs = { ...mundo.knobs, prospeccaoDias: [1, 2, 3, 4, 5] };
    const { admin } = cenario(campanha("consent"), pendente("ana"));
    await rodarUmaRodadaDeCampanha(admin, SABADO);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("⭐ no feriado nacional (20/11), a prospecção espera, e o destinatário continua pendente", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const r = await rodarUmaRodadaDeCampanha(admin, FERIADO);
    expect(mundo.envios).toEqual([]);
    expect(r.detalhe).toContain("ritmo:feriado");
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
    // Volta à fila à meia-noite de sábado em São Paulo (o fuso dos knobs do teste), e não antes.
    expect(unica(tabelas, "campaign_recipients").next_attempt_at).toBe("2026-11-21T03:00:00.000Z");
  });

  it("controle: na véspera (19/11) manda; e a de consentimento manda no feriado", async () => {
    const quinta = cenario(campanha("legitimate_interest"), pendente("ana"));
    await rodarUmaRodadaDeCampanha(quinta.admin, QUINTA);
    const feriado = cenario(campanha("consent"), pendente("ana"));
    await rodarUmaRodadaDeCampanha(feriado.admin, FERIADO);
    expect(mundo.envios).toEqual(["conv:ana:chip", "conv:ana:chip"]);
  });
});

describe("2. cancelar: a fila cai antes da campanha", () => {
  const AGORA = QUARTA;
  const carregada = { id: "camp", organization_id: "org-1", name: "x", status: "running" } as never;

  it("⭐ o worker que já tinha escolhido o pendente não consegue reservá-lo depois que o cancelamento começou", async () => {
    const tabelas: Tabelas = {
      campaigns: [{ id: "camp", status: "running" }],
      campaign_recipients: [{ id: "r-ana", campaign_id: "camp", status: "pending" }],
    };
    let reserva: { reservado: boolean; erro?: string } | null = null;
    const admin = fakeAdmin(tabelas, {
      depoisDoUpdate: async (n) => {
        // A corrida: entre o 1º e o 2º update do cancelamento, o worker tenta reservar quem ele já escolheu.
        if (n === 1) reserva = await reservarDestinatario(admin, "r-ana", AGORA);
      },
    });
    const r = await cancelarAcao(admin, carregada, AGORA);
    expect(r.ok).toBe(true);
    expect(reserva).toEqual({ reservado: false });
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
    expect(unica(tabelas, "campaigns").status).toBe("cancelled");
  });

  it("a rodada concluiu a campanha no meio (viu a fila já cancelada): cancelar responde ok, e nada mais sai", async () => {
    const tabelas: Tabelas = {
      campaigns: [{ id: "camp", status: "running" }],
      campaign_recipients: [{ id: "r-ana", campaign_id: "camp", status: "pending" }],
    };
    const admin = fakeAdmin(tabelas, {
      depoisDoUpdate: async (n) => {
        if (n === 1) unica(tabelas, "campaigns").status = "completed";
      },
    });
    const r = await cancelarAcao(admin, carregada, AGORA);
    expect(r).toMatchObject({ ok: true, cancelados: 1 });
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
  });

  it("outra pessoa pausou no meio: o cancelamento responde conflito, como antes, e a fila não volta", async () => {
    const tabelas: Tabelas = {
      campaigns: [{ id: "camp", status: "running" }],
      campaign_recipients: [{ id: "r-ana", campaign_id: "camp", status: "pending" }],
    };
    const admin = fakeAdmin(tabelas, {
      depoisDoUpdate: async (n) => {
        if (n === 1) unica(tabelas, "campaigns").status = "paused";
      },
    });
    const r = await cancelarAcao(admin, carregada, AGORA);
    expect(r).toMatchObject({ ok: false, codigo: "campanha_estado_invalido" });
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
  });
});
