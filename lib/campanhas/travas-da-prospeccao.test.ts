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
 * A segunda revisão adversarial (F4f, mesma data) reprovou a primeira versão das travas com casos
 * concretos, cada um com o seu teste abaixo (o código F01…F19 é o da revisão): a reação contava como
 * resposta; o histórico importado era lido pela hora da importação; o nono dígito parecia troca de
 * telefone; a conversa com dono ou com a IA calada passava; a etiqueta de parada num negócio de outro
 * funil derrubava a pessoa; a conferência acontecia antes da reserva, e não de novo depois dela; os
 * balões seguintes saíam para quem respondeu ao primeiro; a fila era cancelada antes da campanha, e
 * o erro da fila era escondido; a rajada insistia na trava que vale para todos.
 *
 * Campanha de consentimento (base `consent`) segue como antes: as travas são da abordagem fria.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PACING_DEFAULTS, type PacingKnobs } from "@/lib/agent-engine/pacing/defaults";

const mundo = vi.hoisted(() => ({
  knobs: null as unknown as PacingKnobs,
  ledger: new Map<string, Date[]>(),
  envios: [] as string[],
  /** Roda quando a rodada lê os knobs: o meio do caminho entre a 1ª conferência e a reserva (F4f, F05). */
  aoLerKnobs: null as null | (() => void),
  /** Roda dentro do envio; o que devolver vira a resposta do handler (F4f, F10 e F13). */
  aoEnviar: null as null | (() => Promise<Record<string, unknown> | void>),
}));

vi.mock("@/lib/logger", () => ({ logger: { info: () => undefined, warn: () => undefined, error: () => undefined } }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => {
    mundo.aoLerKnobs?.();
    return { knobs: mundo.knobs, numberActivatedAt: null };
  },
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
    return (await mundo.aoEnviar?.()) ?? { id: `msg-${mundo.envios.length}`, status: "queued" };
  },
}));

import { cancelarAcao } from "@/lib/campanhas/acoes";
import { desfechoParaARajada } from "@/lib/campanhas/rajada";
import { reservarDestinatario, rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

type Linha = Record<string, unknown>;
type Tabelas = Record<string, Linha[]>;

/** A única linha que o cenário monta numa tabela (os testes montam uma campanha e um destinatário). */
function unica(tabelas: Tabelas, tabela: string): Linha {
  const linha = tabelas[tabela]?.[0];
  if (!linha) throw new Error(`o cenário não montou ${tabela}`);
  return linha;
}

/** A coluna, inclusive o caminho JSON do PostgREST (`metadata->>historico_importado`). */
function valorDaColuna(l: Linha, coluna: string): unknown {
  const [raiz, chave] = coluna.split("->>");
  if (chave === undefined) return l[coluna];
  const json = l[raiz!] as Record<string, unknown> | null | undefined;
  return json?.[chave] ?? null;
}

/**
 * PostgREST em memória: `eq`, `neq`, `is`, `in`, `gt`, `gte`, `not is null`, `limit`, `update`, `select`,
 * `maybeSingle`, com caminho JSON nas colunas. `depoisDoUpdate(n)` roda depois do n-ésimo `update`
 * resolvido: é onde a corrida com o worker acontece. `falhas`: tabelas cuja leitura devolve erro, como o
 * PostgREST quando o banco cai. O que volta é CÓPIA profunda (ideia da F4f do cxj): a fotografia já lida
 * não pode mudar sozinha quando o cenário mexe na tabela depois.
 */
function fakeAdmin(
  tabelas: Tabelas,
  opcoes: { depoisDoUpdate?: (n: number) => Promise<void>; falhas?: readonly string[] } = {},
) {
  const { depoisDoUpdate, falhas = [] } = opcoes;
  let updates = 0;
  const de = (tabela: string) => {
    const filtros: Array<(l: Linha) => boolean> = [];
    // `tabela|coluna` em `falhas`: só a consulta que filtra por essa coluna falha (a das mensagens importadas).
    const colunas = new Set<string>();
    let limite = Infinity;
    let patch: Linha | null = null;
    const falhou = () => falhas.some((f) => f === tabela || [...colunas].some((c) => f === `${tabela}|${c}`));
    const resolver = async () => {
      if (falhou()) return { data: null, error: { message: `leitura de ${tabela} falhou` }, count: null };
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
                colunas.add(coluna);
                if (coluna === "organizations.status") filtros.push((l) => (l.organizations as Linha).status === valor);
                else filtros.push((l) => valorDaColuna(l, coluna) === valor);
                return b;
              };
            case "neq":
              return (coluna: string, valor: unknown) => (
                colunas.add(coluna), filtros.push((l) => valorDaColuna(l, coluna) !== valor), b
              );
            case "is":
              return (coluna: string, valor: unknown) => (
                colunas.add(coluna), filtros.push((l) => (valorDaColuna(l, coluna) ?? null) === valor), b
              );
            case "in":
              return (coluna: string, valores: unknown[]) => (
                colunas.add(coluna), filtros.push((l) => valores.includes(valorDaColuna(l, coluna))), b
              );
            case "gt":
              return (coluna: string, valor: string) => (
                colunas.add(coluna), filtros.push((l) => String(valorDaColuna(l, coluna) ?? "") > valor), b
              );
            case "gte":
              return (coluna: string, valor: string) => (
                colunas.add(coluna), filtros.push((l) => String(valorDaColuna(l, coluna) ?? "") >= valor), b
              );
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
  extra: { negocios?: Linha[]; conversas?: Linha[]; falhas?: readonly string[] } = {},
) {
  const tabelas: Tabelas = {
    campaigns: [c],
    campaign_recipients: [p],
    campaign_channel_sessions: [],
    channel_sessions: [{ id: "chip", organization_id: "org-1", status: "WORKING", daily_message_limit: null }],
    campaign_suppressions: [],
    messages: mensagens,
    crm_leads: extra.negocios ?? [],
    conversations: extra.conversas ?? [],
  };
  return { tabelas, admin: fakeAdmin(tabelas, { falhas: extra.falhas }) };
}

beforeEach(() => {
  mundo.knobs = { ...PACING_DEFAULTS, throttleMs: 0, jitterMaxMs: 0 };
  mundo.ledger.clear();
  mundo.envios.length = 0;
  mundo.aoLerKnobs = null;
  mundo.aoEnviar = null;
  vi.useRealTimers();
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

  it.each(["messages", "crm_leads", "conversations"])(
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

describe("2. cancelar: a campanha cai, depois a fila, e a reserva relê a campanha", () => {
  const AGORA = QUARTA;
  const carregada = { id: "camp", organization_id: "org-1", name: "x", status: "running" } as never;
  const base = (destinatario: Linha = {}): Tabelas => ({
    campaigns: [{ id: "camp", status: "running" }],
    campaign_recipients: [{ id: "r-ana", campaign_id: "camp", status: "pending", ...destinatario }],
  });

  it("⭐ o worker que já tinha escolhido o pendente o reserva no meio do cancelamento, relê a campanha e solta", async () => {
    const tabelas = base();
    let reserva: unknown = null;
    const admin = fakeAdmin(tabelas, {
      depoisDoUpdate: async (n) => {
        // A corrida: entre a campanha cair e a fila cair, o worker reserva quem ele já tinha escolhido.
        if (n === 1) reserva = await reservarDestinatario(admin, "r-ana", AGORA);
      },
    });
    const r = await cancelarAcao(admin, carregada, AGORA);
    expect(r.ok).toBe(true);
    expect(reserva).toEqual({ reservado: false, parou: true });
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
    expect(unica(tabelas, "campaigns").status).toBe("cancelled");
  });

  it("F4f F18 ⭐ o 429 devolve à fila quem estava em voo, entre as duas escritas: a reserva do worker antigo é solta", async () => {
    const tabelas = base({ status: "sending" });
    let reserva: unknown = null;
    const admin = fakeAdmin(tabelas, {
      depoisDoUpdate: async (n) => {
        if (n !== 1) return;
        unica(tabelas, "campaign_recipients").status = "pending"; // o 429 do envio em voo
        reserva = await reservarDestinatario(admin, "r-ana", AGORA);
      },
    });
    await cancelarAcao(admin, carregada, AGORA);
    expect(reserva).toEqual({ reservado: false, parou: true });
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
  });

  it("F4f F11 ⭐ a fila não caiu (erro do banco): cancelar NÃO responde ok, e a campanha já está cancelada", async () => {
    const tabelas = base();
    const r = await cancelarAcao(fakeAdmin(tabelas, { falhas: ["campaign_recipients"] }), carregada, AGORA);
    expect(r).toMatchObject({ ok: false, codigo: "internal_error" });
    expect(unica(tabelas, "campaigns").status).toBe("cancelled");
  });

  it("F4f F12 ⭐ depois dessa falha, o worker antigo não consegue reservar: a reserva vê a campanha cancelada", async () => {
    const tabelas = base();
    await cancelarAcao(fakeAdmin(tabelas, { falhas: ["campaign_recipients"] }), carregada, AGORA);
    expect(await reservarDestinatario(fakeAdmin(tabelas), "r-ana", AGORA)).toEqual({ reservado: false, parou: true });
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
  });

  it("⭐ campanha pausada depois da reserva: a reserva é solta e a pessoa volta à fila, para a retomada", async () => {
    const tabelas = base();
    tabelas.campaigns = [{ id: "camp", status: "paused" }];
    expect(await reservarDestinatario(fakeAdmin(tabelas), "r-ana", AGORA)).toEqual({ reservado: false, parou: true });
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", sending_at: null });
  });

  it("⭐ sem conseguir ler a campanha depois da reserva: solta e não manda (falha fechada), com o erro real", async () => {
    const tabelas = base();
    const r = await reservarDestinatario(fakeAdmin(tabelas, { falhas: ["campaigns"] }), "r-ana", AGORA);
    expect(r).toEqual({ reservado: false, erro: "leitura de campaigns falhou" });
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", sending_at: null });
  });

  it("⭐ a campanha é cancelada entre a 1ª conferência e a reserva: nada sai, e a rodada diz por quê", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoLerKnobs = () => {
      unica(tabelas, "campaigns").status = "cancelled";
    };
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(r.detalhe).toContain("campanha_parou");
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
  });

  it("controle: campanha em andamento, a reserva vale", async () => {
    const tabelas = base();
    expect(await reservarDestinatario(fakeAdmin(tabelas), "r-ana", AGORA)).toEqual({ reservado: true });
    expect(unica(tabelas, "campaign_recipients").status).toBe("sending");
  });

  it("F4f F09 controle: a mensagem reservada ANTES do cancelamento segue em `sending` (está na borda)", async () => {
    const tabelas = base();
    const admin = fakeAdmin(tabelas);
    expect((await reservarDestinatario(admin, "r-ana", AGORA)).reservado).toBe(true);
    expect(await cancelarAcao(admin, carregada, AGORA)).toMatchObject({ ok: true, cancelados: 0 });
    expect(unica(tabelas, "campaign_recipients").status).toBe("sending");
  });

  it("a rodada já tinha concluído a campanha: cancelar responde ok, e varre o que tiver sobrado na fila", async () => {
    const tabelas = base();
    unica(tabelas, "campaigns").status = "completed";
    const r = await cancelarAcao(fakeAdmin(tabelas), carregada, AGORA);
    expect(r).toMatchObject({ ok: true, cancelados: 1 });
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
  });

  it("outra pessoa pausou antes: conflito, como antes, e a fila da pausada fica para a retomada", async () => {
    const tabelas = base();
    unica(tabelas, "campaigns").status = "paused";
    const r = await cancelarAcao(fakeAdmin(tabelas), carregada, AGORA);
    expect(r).toMatchObject({ ok: false, codigo: "campanha_estado_invalido" });
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
  });
});

describe("4. os contratos da revisão F4f do cxj (11/11/2026)", () => {
  it("F01 ⭐ o mesmo celular com e sem o nono dígito não conta como troca de telefone", async () => {
    const { admin } = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], { recipient_address: "+558899990000" }, { phone_number: "+5588999990000" }),
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("F02 ⭐ reação não é fala: um 👍 depois da preparação não tira a pessoa", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [
      { ...mensagem("inbound", "2026-11-18T12:30:00.000Z"), type: "reaction" },
    ]);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("⭐ histórico importado agora, de conversa ANTIGA, não conta como resposta nova", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [
      {
        ...mensagem("inbound", "2026-11-18T12:30:00.000Z"),
        type: "text",
        sent_at: "2026-10-01T15:00:00.000Z",
        metadata: { historico_importado: "true" },
      },
    ]);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("controle: histórico importado de mensagem que a pessoa mandou DEPOIS da preparação conta", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [
      {
        ...mensagem("inbound", "2026-11-18T12:30:00.000Z"),
        type: "text",
        sent_at: "2026-11-18T12:10:00.000Z",
        metadata: { historico_importado: "true" },
      },
    ]);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("escreveu_depois_da_preparacao");
  });

  it("F03 ⭐ parada em negócio de OUTRO funil, fora do recorte da campanha, não tira a pessoa", async () => {
    const { admin } = cenario(
      campanha("legitimate_interest", {
        audience_filter: { com_todas_tags: ["fa-x"], sem_tags: ["tem-quem-cuide"], funis: ["funil-atual"] },
      }),
      pendente("ana"),
      [],
      {
        negocios: [
          { ...negocio("ana", ["tem-quem-cuide"]), status: "lost", pipeline_id: "funil-antigo" },
          { ...negocio("ana", []), status: "open", pipeline_id: "funil-atual" },
        ],
      },
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("controle: no funil da campanha, a parada vale mesmo com o negócio já perdido (e o público pedindo só abertos)", async () => {
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest", {
        audience_filter: {
          com_todas_tags: ["fa-x"],
          sem_tags: ["tem-quem-cuide"],
          funis: ["funil-atual"],
          situacoes_do_negocio: ["open"],
        },
      }),
      pendente("ana"),
      [],
      { negocios: [{ ...negocio("ana", ["tem-quem-cuide"]), status: "lost", pipeline_id: "funil-atual" }] },
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("etiqueta_de_parada");
  });

  it("F04 ⭐ prospecção sem `prepared_at`: não manda, porque sem o corte não há como conferir a resposta", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest", { prepared_at: null }), pendente("ana"));
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(r.detalhe).toContain("trava:sem_preparacao");
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
  });

  it("F05 ⭐ a resposta chega entre a 1ª conferência e a reserva: a releitura depois da reserva pega", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoLerKnobs = () => {
      tabelas.messages!.push(mensagem("inbound", "2026-11-18T13:59:59.000Z"));
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "skipped",
      exclusion_reason: "escreveu_depois_da_preparacao",
      sending_at: null,
    });
  });

  it("F07 ⭐ o contato vai para atendimento humano entre a 1ª conferência e a reserva: a releitura pega", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoLerKnobs = () => {
      (unica(tabelas, "campaign_recipients").contacts as Linha).force_human = true;
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("atendimento_humano");
  });

  it("⭐ a leitura depois da reserva falha: a reserva é solta, e a pessoa volta à fila", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    // O banco das mensagens cai DEPOIS da 1ª conferência (entre ela e a reserva): as mesmas tabelas, por um
    // cliente que devolve erro na leitura de `messages`.
    const inteiro = admin as unknown as { from: (t: string) => unknown };
    const semMensagens = fakeAdmin(tabelas, { falhas: ["messages"] }) as unknown as { from: (t: string) => unknown };
    let caiu = false;
    mundo.aoLerKnobs = () => {
      caiu = true;
    };
    const r = await rodarUmaRodadaDeCampanha({ from: (t: string) => (caiu ? semMensagens : inteiro).from(t) } as never, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(r.detalhe).toContain("trava:sem_leitura");
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", sending_at: null });
  });

  it("F06 ⭐ a conversa tem um atendente como dono (sem silêncio gravado): não recebe", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      conversas: [
        {
          id: "c1",
          organization_id: "org-1",
          contact_id: "ana",
          status: "open",
          assigned_to_user_id: "u-1",
          bot_silenced_until: null,
        },
      ],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("atendimento_humano");
  });

  it("⭐ só o silêncio vigente da IA, sem atendente, também tira", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      conversas: [
        {
          id: "c1",
          organization_id: "org-1",
          contact_id: "ana",
          status: "open",
          assigned_to_user_id: null,
          bot_silenced_until: "2026-11-18T15:00:00.000Z",
        },
      ],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("atendimento_humano");
  });

  it("controle: silêncio já vencido, conversa encerrada com dono e conversa de outra pessoa não tiram ninguém", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      conversas: [
        { id: "c1", organization_id: "org-1", contact_id: "ana", status: "open", assigned_to_user_id: null, bot_silenced_until: "2026-11-18T13:00:00.000Z" },
        { id: "c2", organization_id: "org-1", contact_id: "ana", status: "closed", assigned_to_user_id: "u-1", bot_silenced_until: null },
        { id: "c3", organization_id: "org-1", contact_id: "bia", status: "open", assigned_to_user_id: "u-1", bot_silenced_until: "infinity" },
      ],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("controle: campanha de consentimento não lê conversa nem negócio, como antes", async () => {
    const { admin } = cenario(campanha("consent"), pendente("ana"), [], {
      conversas: [{ id: "c1", organization_id: "org-1", contact_id: "ana", status: "open", assigned_to_user_id: "u-1", bot_silenced_until: "infinity" }],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("F13 ⭐ balões: a resposta que chega depois do 1º balão segura os seguintes", async () => {
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );
    mundo.aoEnviar = async () => {
      tabelas.messages!.push(mensagem("inbound", "2026-11-18T14:00:00.001Z"));
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("controle: balões sem resposta saem todos", async () => {
    const { admin } = cenario(
      campanha("legitimate_interest", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip", "conv:ana:chip"]);
  });

  it("F14 ⭐ a rajada para quando a trava não consegue ler, em vez de insistir até o prazo", () => {
    expect(desfechoParaARajada("trava:sem_leitura")).toBe(true);
    expect(desfechoParaARajada("trava:sem_preparacao")).toBe(true);
    // E quando a reserva viu a campanha parada: os envios seguintes veriam o mesmo.
    expect(desfechoParaARajada("campanha_parou")).toBe(true);
    // Controle: pular uma pessoa não para a rajada.
    expect(desfechoParaARajada("pulado:atendimento_humano")).toBe(false);
  });

  it("⭐ balões: sem conseguir ler as mensagens depois do 1º balão, os seguintes não saem", async () => {
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );
    const inteiro = admin as unknown as { from: (t: string) => unknown };
    const semMensagens = fakeAdmin(tabelas, { falhas: ["messages"] }) as unknown as { from: (t: string) => unknown };
    let caiu = false;
    mundo.aoEnviar = async () => {
      caiu = true;
    };
    await rodarUmaRodadaDeCampanha({ from: (t: string) => (caiu ? semMensagens : inteiro).from(t) } as never, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    expect(unica(tabelas, "campaign_recipients").status).toBe("sent");
  });

  it("controle: campanha de consentimento em balões manda todos, mesmo com resposta depois do 1º (como antes)", async () => {
    const { tabelas, admin } = cenario(
      campanha("consent", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );
    mundo.aoEnviar = async () => {
      tabelas.messages!.push(mensagem("inbound", "2026-11-18T14:00:00.001Z"));
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip", "conv:ana:chip"]);
  });

  it("⭐ a leitura do histórico importado falhou (a das mensagens ao vivo, não): não manda", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      falhas: ["messages|sent_at"],
    });
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(r.detalhe).toContain("trava:sem_leitura");
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
  });

  it("F19 ⭐ rajada: quem já veio no lote é relido depois da reserva", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(QUARTA);
    const { admin, tabelas } = cenario(
      campanha("legitimate_interest", { velocidade: "rapida", message_mode: "template" }),
      pendente("ana", ["funil-a"], { variables: { modelo: {} } }),
    );
    const bia = pendente("bia", ["funil-a"], { variables: { modelo: {} } });
    tabelas.campaign_recipients!.push(bia);
    mundo.aoEnviar = async () => {
      (bia.contacts as Linha).force_human = true;
    };
    const rodada = rodarUmaRodadaDeCampanha(admin, QUARTA);
    await vi.runAllTimersAsync();
    await rodada;
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    expect(bia).toMatchObject({ status: "skipped", exclusion_reason: "atendimento_humano" });
  });

  it("F10 controle: o 429 depois do cancelamento devolve à fila, e a rodada seguinte não manda", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const carregada = { id: "camp", organization_id: "org-1", name: "x", status: "running" } as never;
    mundo.aoEnviar = async () => {
      await cancelarAcao(admin, carregada, QUARTA);
      return { id: "falha", status: "failed", error_code: "429", error_message: "rate_limited" };
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaigns").status).toBe("cancelled");
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
    await rodarUmaRodadaDeCampanha(admin, new Date(QUARTA.getTime() + 120_000));
    expect(mundo.envios).toHaveLength(1);
  });
});
