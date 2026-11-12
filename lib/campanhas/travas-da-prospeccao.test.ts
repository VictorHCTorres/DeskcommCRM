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
import { dayStartInTz } from "@/lib/agent-engine/pacing/engine";
import type { RegraDaVaga } from "@/lib/agent-engine/pacing/store";
import { PROVIDERS_DE_MENSAGEM, canalTemRiscoDeBanimento } from "@/lib/channels/capabilities";

const mundo = vi.hoisted(() => ({
  knobs: null as unknown as PacingKnobs,
  ledger: new Map<string, Date[]>(),
  envios: [] as string[],
  /** Roda quando a rodada lê os knobs: o meio do caminho entre a 1ª conferência e a reserva (F4f, F05). */
  aoLerKnobs: null as null | (() => void),
  /** Roda dentro do envio; o que devolver vira a resposta do handler (F4f, F10 e F13). */
  aoEnviar: null as null | (() => Promise<Record<string, unknown> | void>),
  /** Roda dentro da abertura da conversa: o meio do caminho entre a reserva e o handler (F4g, A3). */
  aoAbrir: null as null | (() => void | Promise<void>),
  /** O contexto que a rodada entregou ao handler, um por balão (F4g, A3 e A5). */
  ctxs: [] as Array<Record<string, unknown>>,
  /** O que foi para `logger.error`: o veto que não se grava tem de deixar rastro (F4i, H08). */
  erros: [] as unknown[][],
  /** O que foi para `logger.warn`: a rodada que falhou diz o que a rajada já tinha feito (F4k, K08). */
  avisos: [] as unknown[][],
  /** Roda dentro do registro da vaga no ledger do número; o que lançar é o INSERT recusado (F4l, L03/L06). */
  aoRegistrar: null as null | ((numero: string) => void),
  /** Cada vaga pedida ao ledger do número (`reservarVaga`), na ordem, com a regra que a rodada mandou (F4n, N12). */
  reservas: [] as Array<{ numero: string; quando: Date; regra: RegraDaVaga }>,
  /** Roda dentro da devolução da vaga de um envio que não saiu; o que lançar é o DELETE recusado (F4m, M01). */
  aoDesfazer: null as null | ((numero: string) => void),
  /** A ativação dos números (`channel_knobs.number_activated_at`): a idade que escolhe o degrau do aquecimento. */
  ativadoEm: null as Date | null,
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: () => undefined,
    warn: (...args: unknown[]) => void mundo.avisos.push(args),
    error: (...args: unknown[]) => void mundo.erros.push(args),
  },
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: () => ({}) }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({
  loadChannelKnobs: async () => {
    mundo.aoLerKnobs?.();
    return { knobs: mundo.knobs, numberActivatedAt: mundo.ativadoEm };
  },
  // Como o de verdade (store.ts), a ativação volta como veio na entrada.
  loadPacingState: async (
    _pool: unknown,
    _org: string,
    sessionId: string,
    entrada?: { numberActivatedAt: Date | null },
  ) => {
    const envios = mundo.ledger.get(sessionId) ?? [];
    return {
      lastSentAt: envios.at(-1) ?? null,
      sentToday: envios.length,
      numberActivatedAt: entrada?.numberActivatedAt ?? null,
    };
  },
  recordSend: async (_pool: unknown, _org: string, sessionId: string, quando: Date) => {
    mundo.aoRegistrar?.(sessionId);
    mundo.ledger.set(sessionId, [...(mundo.ledger.get(sessionId) ?? []), quando]);
  },
  // A reserva em RAM, com a regra de `reservarVaga` (store.ts): o teto conta as linhas do número (como o
  // `loadPacingState` daqui), e o intervalo parte da mais recente. Sem `await` entre a conta e a gravação, o
  // passo é atômico; a trava de verdade, com conexões disputando a vaga, é provada no Postgres
  // (`tests/invariants/pacing-ledger-reserva-atomica.test.ts`). O que `aoRegistrar` lançar é o erro do banco.
  // A rodada manda o relógio (versão 15, F4t do cxj, T02): o dublê o lê depois de `aoRegistrar`, como o store o lê
  // sob a trava, depois da espera.
  reservarVaga: async (_pool: unknown, _org: string, sessionId: string, relogio: Date | (() => Date), regra: RegraDaVaga) => {
    mundo.aoRegistrar?.(sessionId);
    const quando = typeof relogio === "function" ? relogio() : relogio;
    mundo.reservas.push({ numero: sessionId, quando, regra });
    const linhas = mundo.ledger.get(sessionId) ?? [];
    if (regra.limite !== null && linhas.length + regra.vagas > regra.limite) return "teto_cheio";
    const ultimo = Math.max(...linhas.map((d) => d.getTime()));
    if (regra.intervaloMs > 0 && linhas.length > 0 && quando.getTime() - ultimo < regra.intervaloMs) return "intervalo";
    mundo.ledger.set(sessionId, [...linhas, quando]);
    return "reservada";
  },
  undoSend: async (_pool: unknown, _org: string, sessionId: string, quando: Date) => {
    mundo.aoDesfazer?.(sessionId);
    const envios = mundo.ledger.get(sessionId) ?? [];
    const i = envios.findIndex((d) => d.getTime() === quando.getTime());
    if (i >= 0) mundo.ledger.set(sessionId, envios.filter((_, j) => j !== i));
  },
}));
vi.mock("@/lib/atendimento/origem", () => ({
  beginServiceAtOrigin: async (_admin: unknown, _org: string, contato: string, sessionId: string) => {
    await mundo.aoAbrir?.();
    return { conversation_id: `conv:${contato}:${sessionId}` };
  },
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: async (_admin: unknown, ctx: { serviceBoundary: { conversation_id: string } }) => {
    mundo.ctxs.push(ctx as unknown as Record<string, unknown>);
    mundo.envios.push(ctx.serviceBoundary.conversation_id);
    // O envio que saiu: o handler devolve a linha `sent`. A fila física (`queued`) é cenário próprio (F4i, I05).
    return (await mundo.aoEnviar?.()) ?? { id: `msg-${mundo.envios.length}`, status: "sent" };
  },
}));

import { cancelarAcao } from "@/lib/campanhas/acoes";
import { COLUNAS_DO_DESTINATARIO, ESTADOS_DE_QUEM_RECEBEU, aplicarVeto } from "@/lib/campanhas/conferencia";
import { VetoDaCampanhaError, assertCampaignDelivery, entregaPeloAtor } from "@/lib/campanhas/entrega";
import { hashDoEndereco } from "@/lib/campanhas/exclusoes";
import { desfechoParaARajada } from "@/lib/campanhas/rajada";
import {
  ATRASO_MAXIMO_DA_VAGA_DA_CAMPANHA_MS as FOLGA_DA_VAGA,
  reservarDestinatario,
  retidaPeloCanal,
  rodarUmaRodadaDeCampanha,
} from "@/lib/campanhas/rodada";
import { OrgNaoOperanteError } from "@/lib/organizacao/operante";

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
  opcoes: {
    depoisDoUpdate?: (n: number) => Promise<void>;
    falhas?: readonly string[];
    /** A escrita que o banco recusa (F4j, J06): só o `update` cujo patch casar, e não a leitura da tabela. */
    recusar?: (tabela: string, patch: Linha) => boolean;
  } = {},
) {
  const { depoisDoUpdate, falhas = [], recusar } = opcoes;
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
      if (patch && recusar?.(tabela, patch)) {
        return { data: null, error: { message: `o banco recusou a escrita em ${tabela}` }, count: null };
      }
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
              // Como o PostgREST: mais de uma linha é erro (PGRST116), e não a primeira delas.
              return async () => {
                const r = await resolver();
                if (!r.error && (r.data?.length ?? 0) > 1) {
                  return { data: null, error: { message: "JSON object requested, multiple rows returned" } };
                }
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
    ai_opt_out: false,
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
  mundo.aoAbrir = null;
  mundo.ctxs.length = 0;
  mundo.erros.length = 0;
  mundo.avisos.length = 0;
  mundo.aoRegistrar = null;
  mundo.aoDesfazer = null;
  mundo.reservas.length = 0;
  mundo.ativadoEm = null;
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

  it("A1 ⭐ a rajada para quando o canal segura a mensagem (fila:), em vez de passar a fila inteira pelo canal fora do ar", () => {
    // Com o canal fora do ar, cada envio seguinte também ficaria retido: a
    // pessoa voltaria à fila e a conversa ganharia uma mensagem `failed` a cada
    // tentativa. Como `canal:`, o desfecho vale para os envios seguintes.
    expect(desfechoParaARajada("fila:canal_indisponivel")).toBe(true);
    // O incerto também para: se a mensagem saiu sem ser marcada, o canal está
    // em estado que não se confere.
    expect(desfechoParaARajada("fila:envio_incerto")).toBe(true);
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

describe("5. os contratos da revisão F4g do cxj (11/11/2026): a conferência final", () => {
  const NUMERO = "+5588999990000";
  const naLista = (endereco = NUMERO): Linha => ({
    organization_id: "org-1",
    recipient_address_hash: hashDoEndereco(endereco),
  });
  const contatoDe = (tabelas: Tabelas) => unica(tabelas, "campaign_recipients").contacts as Linha;
  const emBaloes = () =>
    cenario(
      campanha("legitimate_interest", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );

  it("A1 ⭐ o contato pediu para não falar com a IA (ai_opt_out): não recebe", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], {}, { ai_opt_out: true }));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "atendimento_humano" });
  });

  it("A1 ⭐ o ai_opt_out chega entre a 1ª conferência e a reserva: a releitura pega", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoLerKnobs = () => {
      contatoDe(tabelas).ai_opt_out = true;
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", sending_at: null });
  });

  it("A2 ⭐ recusou marketing entre a 1ª conferência e a reserva: não recebe", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoLerKnobs = () => {
      contatoDe(tabelas).consent = { marketing: { declined_at: "2026-11-18T13:59:00.000Z" } };
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "skipped",
      exclusion_reason: "recusou_marketing",
      sending_at: null,
    });
  });

  it("A2 ⭐ bloqueou entre a 1ª conferência e a reserva: sai como opt-out, e não recebe", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoLerKnobs = () => {
      contatoDe(tabelas).is_blocked = true;
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "opted_out",
      exclusion_reason: "opt_out",
      opted_out_at: QUARTA.toISOString(),
    });
  });

  it("A2 ⭐ bloqueou entre a 1ª conferência e a reserva: a conversa nem é aberta", async () => {
    // A conferência depois da reserva roda ANTES de abrir a conversa: abrir também mexe no banco (a conversa e o
    // vínculo do destinatário com ela), e por uma pessoa que não vai receber.
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    let aberturas = 0;
    mundo.aoLerKnobs = () => {
      contatoDe(tabelas).is_blocked = true;
    };
    mundo.aoAbrir = () => {
      aberturas += 1;
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(aberturas).toBe(0);
    expect(unica(tabelas, "campaign_recipients").conversation_id ?? null).toBeNull();
  });

  it("A2 ⭐ 1ª conferência: bloqueado sai como opt-out, com a data; quem recusou marketing, como pulado", async () => {
    const bloqueado = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], {}, { is_blocked: true }));
    await rodarUmaRodadaDeCampanha(bloqueado.admin, QUARTA);
    expect(unica(bloqueado.tabelas, "campaign_recipients")).toMatchObject({
      status: "opted_out",
      exclusion_reason: "opt_out",
      opted_out_at: QUARTA.toISOString(),
    });
    const recusou = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], {}, { consent: { marketing: { declined_at: "2026-11-17T10:00:00.000Z" } } }),
    );
    await rodarUmaRodadaDeCampanha(recusou.admin, QUARTA);
    expect(unica(recusou.tabelas, "campaign_recipients")).toMatchObject({
      status: "skipped",
      exclusion_reason: "recusou_marketing",
    });
    expect(mundo.envios).toEqual([]);
  });

  it("A2 ⭐ entrou na lista de exclusão entre a 1ª conferência e a reserva: não recebe", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoLerKnobs = () => {
      tabelas.campaign_suppressions!.push(naLista());
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "suprimido" });
  });

  it.each(["legitimate_interest", "consent"] as const)(
    "A2 ⭐ a leitura da lista de exclusão falhou (%s): não manda, e o destinatário continua pendente",
    async (base) => {
      const { tabelas, admin } = cenario(campanha(base), pendente("ana"), [], { falhas: ["campaign_suppressions"] });
      const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
      expect(mundo.envios).toEqual([]);
      expect(r.detalhe).toContain("trava:sem_leitura");
      expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
    },
  );

  it("A2 ⭐ o número aparece duas vezes na lista de exclusão: continua excluído", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    tabelas.campaign_suppressions!.push(naLista(), naLista("+55 (88) 99999-0000"));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("suprimido");
  });

  it("A2 ⭐ a lista tem o número aprovado na preparação, e o cadastro está noutra grafia: excluído", async () => {
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], { recipient_address: "+558899990000" }, { phone_number: NUMERO }),
    );
    tabelas.campaign_suppressions!.push(naLista("+558899990000"));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("suprimido");
  });

  it("A2 ⭐ a lista tem o número da ficha, e o aprovado está sem o nono dígito: não recebe", async () => {
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], { recipient_address: "+558899990000" }, { phone_number: NUMERO }),
    );
    tabelas.campaign_suppressions!.push(naLista(NUMERO));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("suprimido");
  });

  it("A2 controle: a lista de OUTRA organização não vale aqui", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    tabelas.campaign_suppressions!.push({ ...naLista(), organization_id: "org-2" });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("A3 ⭐ outro envio já levou a pessoa enquanto a conversa era aberta: este não manda, e não mexe nela", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoAbrir = () => {
      unica(tabelas, "campaign_recipients").status = "sent";
    };
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").status).toBe("sent");
    // Não é a campanha que parou (a rajada seguiria parada à toa): é este destinatário que saiu da reserva.
    expect(r.detalhe).toBe("camp:destinatario_fora_da_reserva");
  });

  it("A3 ⭐ a pessoa responde enquanto a conversa é aberta: o handler não é chamado", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoAbrir = () => {
      tabelas.messages!.push(mensagem("inbound", "2026-11-18T13:59:59.500Z"));
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "skipped",
      exclusion_reason: "escreveu_depois_da_preparacao",
      sending_at: null,
    });
  });

  it("A3 ⭐ a campanha é cancelada enquanto a conversa é aberta: nada sai, e o destinatário é cancelado", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoAbrir = () => {
      unica(tabelas, "campaigns").status = "cancelled";
    };
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(r.detalhe).toContain("campanha_parou");
    expect(unica(tabelas, "campaign_recipients").status).toBe("cancelled");
  });

  it("A3 ⭐ a campanha é pausada enquanto a conversa é aberta: nada sai, e o destinatário volta à fila", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoAbrir = () => {
      unica(tabelas, "campaigns").status = "paused";
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", sending_at: null });
  });

  it.each([
    ["a etiqueta de parada", (t: Tabelas): string => ((contatoDe(t).tags as string[]).push("tem-quem-cuide"), "etiqueta_de_parada")],
    [
      "um atendente como dono da conversa",
      (t: Tabelas): string => (
        t.conversations!.push({
          id: "c1",
          organization_id: "org-1",
          contact_id: "ana",
          status: "open",
          assigned_to_user_id: "u-1",
          bot_silenced_until: null,
        }),
        "atendimento_humano"
      ),
    ],
    [
      "a recusa de marketing",
      (t: Tabelas): string => ((contatoDe(t).consent = { marketing: { declined_at: "2026-11-18T13:59:00.000Z" } }), "recusou_marketing"),
    ],
  ] as const)("A3 ⭐ %s chega enquanto a conversa é aberta: nada sai", async (_nome, mexer) => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    let esperado = "";
    mundo.aoAbrir = () => {
      esperado = mexer(tabelas);
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: esperado });
  });

  // F4i (I01 do cxj): a v3 entregava só no 1º balão, e os seguintes perdiam a conferência dentro do handler e o
  // destino congelado. Agora todo balão leva a entrega; o 1º, exatamente como antes.
  it("A3/I01 a rodada entrega ao handler a conferência da campanha, com o número aprovado, em todo balão", async () => {
    const { admin } = emBaloes();
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.ctxs).toHaveLength(2);
    expect(mundo.ctxs[0]!.campaignDelivery).toEqual({
      organizationId: "org-1",
      campaignId: "camp",
      recipientId: "r-ana",
      destinoAprovado: NUMERO,
    });
    expect(mundo.ctxs[1]!.campaignDelivery).toEqual({
      organizationId: "org-1",
      campaignId: "camp",
      recipientId: "r-ana",
      destinoAprovado: NUMERO,
      estadosAceitos: [...ESTADOS_DE_QUEM_RECEBEU],
    });
  });

  it("A3 controle: a campanha de consentimento não leva a conferência da prospecção ao handler", async () => {
    const { admin } = cenario(campanha("consent"), pendente("ana"));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.ctxs).toHaveLength(1);
    expect(mundo.ctxs[0]!.campaignDelivery).toBeUndefined();
  });

  it.each([
    [{ pular: "recusou_marketing" }, { status: "skipped", eligibility_status: "excluded", exclusion_reason: "recusou_marketing" }],
    [{ pular: "opt_out" }, { status: "opted_out", exclusion_reason: "opt_out" }],
    [{ esperar: "sem_leitura" }, { status: "pending", sending_at: null }],
    [{ parou: "paused" }, { status: "pending", sending_at: null }],
    [{ parou: "cancelled" }, { status: "cancelled" }],
  ] as const)("A3 ⭐ o handler recusa com o veto %j: o destinatário segue o veto, e não vira falha", async (veto, esperado) => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => {
      throw new VetoDaCampanhaError(veto);
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject(esperado);
    expect(unica(tabelas, "campaign_recipients").last_error_code).toBeUndefined();
  });

  it("A3 ⭐ a conferência do handler: o veto vira VetoDaCampanhaError; sem veto, passa", async () => {
    const entrega = { organizationId: "org-1", campaignId: "camp", recipientId: "r-ana", destinoAprovado: NUMERO };
    const reservado = { status: "sending" };
    const livre = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], reservado));
    await expect(assertCampaignDelivery(livre.admin, entrega, QUARTA)).resolves.toBeUndefined();
    const semIA = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], reservado, { ai_opt_out: true }));
    const erro = await assertCampaignDelivery(semIA.admin, entrega, QUARTA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VetoDaCampanhaError);
    expect((erro as VetoDaCampanhaError).veto).toEqual({ pular: "atendimento_humano" });
    // Fora da reserva (outro worker já devolveu à fila): não manda.
    const fora = cenario(campanha("legitimate_interest"), pendente("ana"));
    const erroFora = await assertCampaignDelivery(fora.admin, entrega, QUARTA).catch((e: unknown) => e);
    expect((erroFora as VetoDaCampanhaError).veto).toEqual({ parou: "destinatario" });
  });

  it.each([
    ["a campanha não pode ser lida", { falhas: ["campaigns"] }, {}],
    ["o destinatário não pode ser lido", { falhas: ["campaign_recipients"] }, {}],
    ["a entrega diz outra organização", {}, { organizationId: "org-2" }],
    ["a entrega diz outra campanha", {}, { campaignId: "camp-2" }],
  ] as const)("A3 ⭐ a conferência do handler não passa quando %s (falha fechada)", async (_nome, opcoes, mudar) => {
    const entrega = { organizationId: "org-1", campaignId: "camp", recipientId: "r-ana", destinoAprovado: NUMERO };
    const { tabelas } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { status: "sending" }));
    // Uma segunda campanha rodando, da mesma organização: o destinatário não é dela.
    tabelas.campaigns!.push({ ...unica(tabelas, "campaigns"), id: "camp-2" });
    const admin = fakeAdmin(tabelas, opcoes as { falhas?: readonly string[] });
    const erro = await assertCampaignDelivery(admin, { ...entrega, ...mudar }, QUARTA).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VetoDaCampanhaError);
    expect((erro as VetoDaCampanhaError).veto).toEqual({ esperar: "sem_leitura" });
  });

  it("A3 ⭐ aplicar o veto não escreve por cima de quem já saiu da reserva", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { status: "sent" }));
    await aplicarVeto(admin, "r-ana", { pular: "recusou_marketing" }, QUARTA);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent" });
    expect(unica(tabelas, "campaign_recipients").exclusion_reason ?? null).toBeNull();
  });

  it.each([
    ["vai para atendimento humano", (t: Tabelas): void => void (contatoDe(t).force_human = true)],
    ["pede para não falar com a IA", (t: Tabelas): void => void (contatoDe(t).ai_opt_out = true)],
    ["recusa marketing", (t: Tabelas): void => void (contatoDe(t).consent = { marketing: { declined_at: "2026-11-18T14:00:00.000Z" } })],
    ["ganha a etiqueta de parada", (t: Tabelas): void => void (contatoDe(t).tags as string[]).push("parar")],
    ["entra na lista de exclusão", (t: Tabelas): void => void t.campaign_suppressions!.push(naLista())],
    ["tem a campanha cancelada", (t: Tabelas): void => void (unica(t, "campaigns").status = "cancelled")],
  ] as const)("A4 ⭐ balões: a pessoa %s depois do 1º balão: os seguintes não saem", async (_nome, mexer) => {
    const { tabelas, admin } = emBaloes();
    mundo.aoEnviar = async () => {
      mexer(tabelas);
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    // O 1º balão saiu: a pessoa recebeu o começo, e o destinatário conta como enviado.
    expect(unica(tabelas, "campaign_recipients").status).toBe("sent");
  });

  it.each(["sent", "delivered", "read"])("A4 controle: o ack do 1º balão já marcou o destinatário como %s: os seguintes saem", async (estado) => {
    const { tabelas, admin } = emBaloes();
    mundo.aoEnviar = async () => {
      unica(tabelas, "campaign_recipients").status = estado;
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip", "conv:ana:chip"]);
  });

  it("A5 ⭐ o handler recebe o número APROVADO, mesmo com a outra grafia da mesma pessoa na ficha", async () => {
    const { admin } = cenario(
      campanha("legitimate_interest"),
      pendente("ana", ["funil-a"], { recipient_address: "+558899990000" }, { phone_number: NUMERO }),
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.ctxs).toHaveLength(1);
    expect((mundo.ctxs[0]!.campaignDelivery as { destinoAprovado: string }).destinoAprovado).toBe("+558899990000");
  });

  it("A3 ⭐ a conferência do handler não deixa sair de novo para quem já recebeu", async () => {
    const entrega = { organizationId: "org-1", campaignId: "camp", recipientId: "r-ana", destinoAprovado: NUMERO };
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { status: "sent" }));
    const erro = await assertCampaignDelivery(admin, entrega, QUARTA).catch((e: unknown) => e);
    expect((erro as VetoDaCampanhaError).veto).toEqual({ parou: "destinatario" });
  });

  it("controle: na campanha de consentimento, os balões seguem como antes, sem reler a campanha entre eles", async () => {
    // As travas da conferência final são da abordagem fria; a campanha de consentimento não ganha leitura nova.
    const { tabelas, admin } = cenario(
      campanha("consent", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );
    const inteiro = admin as unknown as { from: (t: string) => unknown };
    const semCampanha = fakeAdmin(tabelas, { falhas: ["campaigns"] }) as unknown as { from: (t: string) => unknown };
    let caiu = false;
    mundo.aoEnviar = async () => {
      caiu = true;
    };
    await rodarUmaRodadaDeCampanha({ from: (t: string) => (caiu ? semCampanha : inteiro).from(t) } as never, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip", "conv:ana:chip"]);
  });

  it("A5 ⭐ prospecção sem o número aprovado na preparação: não há destino conferido, e não manda", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { recipient_address: null }));
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "destino_mudou" });
  });

  it("A3 o veto da pessoa no handler conta como pulado na rodada; o de leitura, não", async () => {
    const pula = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => {
      throw new VetoDaCampanhaError({ pular: "recusou_marketing" });
    };
    expect(await rodarUmaRodadaDeCampanha(pula.admin, QUARTA)).toMatchObject({ pulados: 1, enviadas: 0 });
    const espera = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => {
      throw new VetoDaCampanhaError({ esperar: "sem_leitura" });
    };
    expect(await rodarUmaRodadaDeCampanha(espera.admin, QUARTA)).toMatchObject({ pulados: 0, enviadas: 0 });
  });

  it("A3 o veto antes do 1º balão conta como pulado; a campanha parada, não", async () => {
    const pula = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoAbrir = () => {
      (unica(pula.tabelas, "campaign_recipients").contacts as Linha).force_human = true;
    };
    expect(await rodarUmaRodadaDeCampanha(pula.admin, QUARTA)).toMatchObject({ pulados: 1, detalhe: "camp:pulado:atendimento_humano" });
    const parou = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoAbrir = () => {
      unica(parou.tabelas, "campaigns").status = "paused";
    };
    expect(await rodarUmaRodadaDeCampanha(parou.admin, QUARTA)).toMatchObject({ pulados: 0, detalhe: "camp:campanha_parou" });
  });

  it("A7 ⭐ mensagem com a marca de importação 'false' é do caminho ao vivo: conta pela hora em que chegou", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [
      {
        ...mensagem("inbound", "2026-11-18T12:30:00.000Z"),
        type: "text",
        sent_at: "2026-10-01T15:00:00.000Z",
        metadata: { historico_importado: "false" },
      },
    ]);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").exclusion_reason).toBe("escreveu_depois_da_preparacao");
  });

  it("G13 ⭐ rajada: o 2º do lote recusa marketing enquanto o 1º sai: não recebe", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(QUARTA);
    const { admin, tabelas } = cenario(
      campanha("legitimate_interest", { velocidade: "rapida", message_mode: "template" }),
      pendente("ana", ["funil-a"], { variables: { modelo: {} } }),
    );
    const bia = pendente("bia", ["funil-a"], { variables: { modelo: {} } });
    tabelas.campaign_recipients!.push(bia);
    mundo.aoEnviar = async () => {
      (bia.contacts as Linha).consent = { marketing: { declined_at: "2026-11-18T14:00:00.000Z" } };
    };
    const rodada = rodarUmaRodadaDeCampanha(admin, QUARTA);
    await vi.runAllTimersAsync();
    await rodada;
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    expect(bia).toMatchObject({ status: "skipped", exclusion_reason: "recusou_marketing" });
  });
});

/** Uma consulta que devolve erro, qualquer que seja o filtro: o PostgREST com o banco fora. */
function cadeiaComErro(mensagem: string): Record<string, unknown> {
  const cadeia: Record<string, unknown> = new Proxy(
    {},
    {
      get: (_alvo, metodo) =>
        metodo === "then"
          ? (ok: (v: unknown) => unknown, falha?: (e: unknown) => unknown) =>
              Promise.resolve({ data: null, error: { message: mensagem } }).then(ok, falha)
          : () => cadeia,
    },
  );
  return cadeia;
}

const APROVADO = "+5588999990000";
const emBaloes = (texto = "Primeiro parágrafo.\n\nSegundo parágrafo.") =>
  cenario(campanha("legitimate_interest", { split_messages: true }), pendente("ana", ["funil-a"], { rendered_body: texto }));
/** O handler devolve a mensagem que ficou na fila física (`queued`), com o motivo que o handler grava, ou sem ele. */
const naFila = (tabelas: Tabelas, id: string, motivo: string | null = "channel_session_not_working") => {
  const linha: Linha = {
    id,
    organization_id: "org-1",
    status: "queued",
    metadata: { source: "campaign", campaign_id: "camp", ...(motivo ? { queued_reason: motivo } : {}) },
  };
  tabelas.messages!.push(linha);
  return structuredClone(linha);
};
const mensagemDe = (tabelas: Tabelas, id: string) => tabelas.messages!.find((m) => m.id === id);
/** Duas campanhas de prospecção com os principais fora do ar: o único número que fala é o vinculado comum (#3112). */
const duasCampanhasNoVinculado = (): Tabelas => {
  const sessao = (id: string, status: string): Linha => ({ id, organization_id: "org-1", status, daily_message_limit: null });
  return {
    campaigns: [
      campanha("legitimate_interest", { id: "camp-a", channel_session_id: "principal-a" }),
      campanha("legitimate_interest", { id: "camp-b", channel_session_id: "principal-b", started_at: "2026-11-18T11:55:05.000Z" }),
    ],
    campaign_recipients: [
      pendente("ana", ["funil-a"], { campaign_id: "camp-a" }),
      pendente("bia", ["funil-a"], { campaign_id: "camp-b", recipient_address: "+5588999991111" }, { phone_number: "+5588999991111" }),
    ],
    campaign_channel_sessions: [
      { organization_id: "org-1", campaign_id: "camp-a", channel_session_id: "vinculado" },
      { organization_id: "org-1", campaign_id: "camp-b", channel_session_id: "vinculado" },
    ],
    channel_sessions: [sessao("principal-a", "STOPPED"), sessao("principal-b", "STOPPED"), sessao("vinculado", "WORKING")],
    campaign_suppressions: [],
    messages: [],
    crm_leads: [],
    conversations: [],
  };
};

describe("6. os contratos da revisão F4i do cxj (11/11/2026): a fila do canal, todos os balões, a passagem", () => {
  it("I05 ⭐ o canal segurou a mensagem (queued, com o motivo): não conta como enviada, sai da fila física, e a pessoa volta à fila da campanha", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => naFila(tabelas, "m-retida");
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    const destinatario = unica(tabelas, "campaign_recipients");
    expect(destinatario).toMatchObject({ status: "pending", last_error_code: "canal_indisponivel", sending_at: null });
    expect(destinatario.next_attempt_at).toBe(new Date(QUARTA.getTime() + 60_000).toISOString());
    expect(destinatario.message_id ?? null).toBeNull();
    expect(mensagemDe(tabelas, "m-retida")).toMatchObject({ status: "failed", error_code: "campanha_sem_reenvio" });
    expect(r).toMatchObject({ enviadas: 0, detalhe: "camp:fila:canal_indisponivel" });
  });

  it("⭐ queued SEM o motivo (o handler pode ter mandado e só não ter conseguido marcar): não volta à fila, para não repetir", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => naFila(tabelas, "m-incerta", null);
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "failed",
      last_error_code: "envio_incerto",
      message_id: "m-incerta",
    });
    expect(mensagemDe(tabelas, "m-incerta")).toMatchObject({ status: "failed", error_code: "campanha_sem_reenvio" });
    expect(r).toMatchObject({ enviadas: 0, detalhe: "camp:fila:envio_incerto" });
  });

  it("controle: na campanha de consentimento, a mensagem na fila do canal segue como antes (conta como enviada, e o resgate a manda)", async () => {
    const { tabelas, admin } = cenario(campanha("consent"), pendente("ana"));
    mundo.aoEnviar = async () => naFila(tabelas, "m-retida");
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent", message_id: "m-retida" });
    expect(mensagemDe(tabelas, "m-retida")).toMatchObject({ status: "queued" });
  });

  it("controle: a mensagem que saiu segue como antes: o destinatário conta como enviado", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => ({ id: "m-saiu", status: "sent" });
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent", message_id: "m-saiu" });
    expect(r).toMatchObject({ enviadas: 1 });
  });

  it("⭐ balões: o 1º ficou retido pelo canal, e o 2º não sai (sairia sem o 1º se o canal voltasse na pausa)", async () => {
    const { tabelas, admin } = emBaloes();
    mundo.aoEnviar = async () => naFila(tabelas, `m-${mundo.envios.length}`);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", last_error_code: "canal_indisponivel" });
  });

  it("⭐ balões: o 1º saiu e o 2º ficou retido: não volta à fila (repetiria o começo), e o 2º sai da fila física", async () => {
    const { tabelas, admin } = emBaloes();
    mundo.aoEnviar = async () => (mundo.envios.length === 1 ? { id: "m-1", status: "sent" } : naFila(tabelas, "m-2"));
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "failed",
      last_error_code: "canal_indisponivel",
      message_id: "m-1",
    });
    expect(mensagemDe(tabelas, "m-2")).toMatchObject({ status: "failed", error_code: "campanha_sem_reenvio" });
    expect(r).toMatchObject({ enviadas: 0 });
  });

  it("I01 ⭐ todos os balões levam a entrega ao handler, com o destino aprovado; os seguintes aceitam quem o ack do 1º já avançou", async () => {
    const { admin } = emBaloes();
    mundo.aoEnviar = async () => ({ id: `m-${mundo.envios.length}`, status: "sent" });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    const entregas = mundo.ctxs.map((c) => c.campaignDelivery as Record<string, unknown> | undefined);
    expect(entregas).toHaveLength(2);
    expect(entregas[0]).toMatchObject({ campaignId: "camp", recipientId: "r-ana", destinoAprovado: APROVADO });
    // O 1º balão segue byte a byte o de antes: só o destinatário reservado (`sending`), o padrão da conferência.
    expect(entregas[0]!.estadosAceitos).toBeUndefined();
    expect(entregas[1]).toMatchObject({
      campaignId: "camp",
      recipientId: "r-ana",
      destinoAprovado: APROVADO,
      estadosAceitos: [...ESTADOS_DE_QUEM_RECEBEU],
    });
  });

  it("⭐ o handler veta um balão SEGUINTE: o começo saiu e conta como enviado, e o resto não sai", async () => {
    const { tabelas, admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    mundo.aoEnviar = async () => {
      if (mundo.envios.length === 2) throw new VetoDaCampanhaError({ pular: "escreveu_depois_da_preparacao" });
      return { id: `m-${mundo.envios.length}`, status: "sent" };
    };
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toHaveLength(2);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent", message_id: "m-1" });
    expect(r).toMatchObject({ enviadas: 1, pulados: 0 });
  });

  it("⭐ a conferência do handler, num balão seguinte, aceita quem o ack do 1º já avançou", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { status: "delivered" }));
    const entrega = {
      organizationId: "org-1",
      campaignId: "camp",
      recipientId: "r-ana",
      destinoAprovado: APROVADO,
      estadosAceitos: ESTADOS_DE_QUEM_RECEBEU,
    };
    await expect(assertCampaignDelivery(admin, entrega, QUARTA)).resolves.toBeUndefined();
  });

  const passagem = (contato: string, quando: string, status = "resolved"): Linha => ({
    organization_id: "org-1",
    contact_id: contato,
    status,
    last_handoff_at: quando,
    assigned_to_user_id: "humano",
    bot_silenced_until: null,
  });

  it("I03 ⭐ passou a uma pessoa depois da preparação, e a conversa já foi encerrada: não recebe", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      conversas: [passagem("ana", "2026-11-18T13:00:00.000Z")],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "skipped", exclusion_reason: "atendimento_humano" });
  });

  it("controle: a passagem foi ANTES da preparação, numa conversa encerrada: recebe", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      conversas: [passagem("ana", "2026-11-18T10:00:00.000Z")],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  it("controle: a passagem de OUTRA pessoa não tira ninguém; e a campanha de consentimento não lê passagem", async () => {
    const outra = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      conversas: [passagem("bia", "2026-11-18T13:00:00.000Z")],
    });
    await rodarUmaRodadaDeCampanha(outra.admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    const consentimento = cenario(campanha("consent"), pendente("ana"), [], {
      conversas: [passagem("ana", "2026-11-18T13:00:00.000Z")],
    });
    // A rodada seguinte, um minuto depois (versão 15): a vaga da 1ª leva a hora lida na reserva, um pouco depois de
    // QUARTA, e outra rodada com o mesmo QUARTA a veria no futuro, dentro do intervalo do número.
    await rodarUmaRodadaDeCampanha(consentimento.admin, new Date(QUARTA.getTime() + 60_000));
    expect(mundo.envios).toEqual(["conv:ana:chip", "conv:ana:chip"]);
  });

  it("⭐ sem conseguir ler as passagens: não manda (falha fechada), e a pessoa fica na fila", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const inteiro = admin as unknown as { from: (t: string) => Record<string, unknown> };
    const semPassagens = {
      from: (tabela: string) => {
        const consulta = inteiro.from(tabela);
        if (tabela !== "conversations") return consulta;
        return new Proxy(consulta, {
          get: (alvo, metodo) =>
            metodo === "select"
              ? (colunas: string) =>
                  colunas.includes("last_handoff_at")
                    ? cadeiaComErro("leitura das passagens falhou")
                    : (alvo.select as (c: string) => unknown)(colunas)
              : alvo[metodo as string],
        });
      },
    };
    await rodarUmaRodadaDeCampanha(semPassagens as never, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
  });

  it("⭐ aplicar o veto sem conseguir gravar: não finge que pulou, e a rodada diz que o veto ficou sem registro", async () => {
    const { tabelas } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { status: "sending" }));
    const semGravar = fakeAdmin(tabelas, { falhas: ["campaign_recipients"] });
    expect(await aplicarVeto(semGravar, "r-ana", { pular: "recusou_marketing" }, QUARTA)).toBe("veto_sem_registro");
    expect(unica(tabelas, "campaign_recipients").status).toBe("sending");
    // O destinatário fica reservado e nenhuma rodada o pega de novo: sem o log, ninguém saberia por quê.
    expect(mundo.erros).toEqual([
      ["[campanha] o veto da conferência final não foi gravado", expect.objectContaining({ destinatario: "r-ana" })],
    ]);
  });

  // ─── O que o arnês de mutações da v4 achou sem teste (11/11/2026, 18h23). Só testes: a produção não mudou. ───

  it.each(["sent", "delivered", "read"])(
    "A1 a mensagem que voltou do handler como %s saiu: conta como enviada, e o destinatário fica enviado",
    async (estado) => {
      const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
      mundo.aoEnviar = async () => ({ id: "m-saiu", status: estado });
      const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
      expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent", message_id: "m-saiu" });
      expect(r).toMatchObject({ enviadas: 1 });
    },
  );

  it.each([
    ["queued, com o motivo gravado pelo handler", { status: "queued", metadata: { queued_reason: "channel_session_not_working" } }, true],
    ["sent, com o motivo que ficou no metadata", { status: "sent", metadata: { queued_reason: "channel_session_not_working" } }, false],
    ["queued, com o motivo vazio", { status: "queued", metadata: { queued_reason: "" } }, false],
    ["queued, com um motivo que não é texto", { status: "queued", metadata: { queued_reason: 1 } }, false],
    ["queued, sem metadata", { status: "queued", metadata: null }, false],
  ])("A1 retida pelo canal (certeza de que nada saiu) só com queued e o motivo em texto: %s → %s", (_caso, m, esperado) => {
    expect(retidaPeloCanal(m)).toBe(esperado);
  });

  it("A1 tirar da fila física só mexe na mensagem da organização da campanha", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const deOutra: Linha = { id: "m-retida", organization_id: "org-2", status: "queued", metadata: {} };
    tabelas.messages!.push(deOutra);
    mundo.aoEnviar = async () => naFila(tabelas, "m-retida");
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(deOutra).toMatchObject({ status: "queued" });
    expect(tabelas.messages!.find((m) => m.id === "m-retida" && m.organization_id === "org-1")).toMatchObject({
      status: "failed",
      error_code: "campanha_sem_reenvio",
    });
  });

  it("A1 a mensagem que outro caminho já tirou de queued não é reescrita (compare-and-set)", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => {
      const devolvida = naFila(tabelas, "m-retida");
      Object.assign(mensagemDe(tabelas, "m-retida")!, { status: "sent" });
      return devolvida;
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mensagemDe(tabelas, "m-retida")).toMatchObject({ status: "sent" });
    expect(mensagemDe(tabelas, "m-retida")!.error_code).toBeUndefined();
  });

  it.each([
    ["com o motivo (voltaria à fila)", "channel_session_not_working"],
    ["sem o motivo (envio incerto)", null],
  ] as const)(
    "A1 o destinatário que saiu da reserva enquanto o handler respondia (%s) não é reescrito",
    async (_caso, motivo) => {
      const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
      mundo.aoEnviar = async () => {
        Object.assign(unica(tabelas, "campaign_recipients"), { status: "cancelled" });
        return naFila(tabelas, "m-retida", motivo);
      };
      await rodarUmaRodadaDeCampanha(admin, QUARTA);
      expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "cancelled" });
    },
  );

  it("A1 o envio incerto conta o número como usado: a outra campanha que divide o vinculado não fala por ele na mesma rodada", async () => {
    const tabelas = duasCampanhasNoVinculado();
    mundo.aoEnviar = async () => naFila(tabelas, `m-${mundo.envios.length}`, null);
    await rodarUmaRodadaDeCampanha(fakeAdmin(tabelas), QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:vinculado"]);
    expect(tabelas.campaign_recipients!.find((d) => d.id === "r-bia")).toMatchObject({ status: "pending" });
  });

  it("I03 controle: a passagem numa conversa de OUTRA organização não tira a pessoa desta campanha", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], {
      conversas: [{ ...passagem("ana", "2026-11-18T13:00:00.000Z"), organization_id: "org-2" }],
    });
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
  });

  const doAtor = (organizacao: string, tipo: string) => ({ organization_id: organizacao, actor: { type: tipo, id: "campaign:camp" } });

  it("H07 controle: a entrega montada pelo ator da rodada leva a campanha, o destinatário e o número congelado", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    await expect(entregaPeloAtor(admin, doAtor("org-1", "webhook_source"), { campaign_recipient_id: "r-ana" })).resolves.toEqual({
      organizationId: "org-1",
      campaignId: "camp",
      recipientId: "r-ana",
      destinoAprovado: APROVADO,
    });
  });

  it("H07 só o ator da rodada (webhook_source) monta a entrega: outro tipo de ator com o mesmo id segue sem ela", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    await expect(entregaPeloAtor(admin, doAtor("org-1", "user"), { campaign_recipient_id: "r-ana" })).resolves.toBeNull();
  });

  it("H07 ⭐ a campanha do ator é procurada só na organização do envio: a de outra organização não se acha, e veta", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    await expect(entregaPeloAtor(admin, doAtor("org-2", "webhook_source"), { campaign_recipient_id: "r-ana" })).rejects.toMatchObject({
      veto: { esperar: "sem_leitura" },
    });
  });

  it("H07 ⭐ o destinatário do metadata tem de ser da campanha do ator: o de outra campanha não se acha, e veta", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { campaign_id: "outra" }));
    await expect(entregaPeloAtor(admin, doAtor("org-1", "webhook_source"), { campaign_recipient_id: "r-ana" })).rejects.toMatchObject({
      veto: { esperar: "sem_leitura" },
    });
  });
});

describe("7. os contratos da revisão F4j do cxj (11/11/2026): a fila que não se lê, a escrita recusada, o teto do número, o balão incerto", () => {
  // ─── J11: a campanha não conclui sem a prova de que a fila acabou ───

  it("J11 ⭐ sem conseguir ler a fila, a campanha não conclui: segue em andamento, a pessoa segue pendente, e nada sai", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"), [], { falhas: ["campaign_recipients"] });
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaigns").status).toBe("running");
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
    expect(mundo.envios).toEqual([]);
    expect(r).toMatchObject({ concluidas: 0 });
  });

  it("J11 ⭐ só a leitura dos pendentes falha (a contagem funciona): a rodada diz erro, e não espera normal", async () => {
    // Sem esta prova, a leitura que falha viraria fila vazia e a contagem diria “aguardando”: a campanha não
    // concluiria, mas o erro sumiria do resultado e do log.
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const inteiro = admin as unknown as { from: (t: string) => Record<string, unknown> };
    const semLeitura = {
      from: (tabela: string) => {
        const consulta = inteiro.from(tabela);
        if (tabela !== "campaign_recipients") return consulta;
        return new Proxy(consulta, {
          get: (alvo, metodo) =>
            metodo === "select"
              ? (colunas: string, opcoes?: { head?: boolean }) =>
                  opcoes?.head
                    ? (alvo.select as (c: string, o?: unknown) => unknown)(colunas, opcoes)
                    : cadeiaComErro("leitura da fila falhou")
              : alvo[metodo as string],
        });
      },
    };
    const r = await rodarUmaRodadaDeCampanha(semLeitura as never, QUARTA);
    expect(r).toMatchObject({ detalhe: "camp:erro", concluidas: 0 });
    expect(unica(tabelas, "campaigns").status).toBe("running");
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
    expect(mundo.envios).toEqual([]);
  });

  it("J11 ⭐ ninguém pendente agora, mas a contagem dos que faltam falha (há um em voo): não conclui", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { status: "sending" }));
    const inteiro = admin as unknown as { from: (t: string) => Record<string, unknown> };
    const semContagem = {
      from: (tabela: string) => {
        const consulta = inteiro.from(tabela);
        if (tabela !== "campaign_recipients") return consulta;
        return new Proxy(consulta, {
          get: (alvo, metodo) =>
            metodo === "select"
              ? (colunas: string, opcoes?: { head?: boolean }) =>
                  opcoes?.head ? cadeiaComErro("contagem da fila falhou") : (alvo.select as (c: string) => unknown)(colunas)
              : alvo[metodo as string],
        });
      },
    };
    const r = await rodarUmaRodadaDeCampanha(semContagem as never, QUARTA);
    expect(unica(tabelas, "campaigns").status).toBe("running");
    expect(r).toMatchObject({ concluidas: 0 });
  });

  it("J11 controle: a fila está mesmo vazia (todos já receberam): conclui", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana", ["funil-a"], { status: "sent" }));
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaigns").status).toBe("completed");
    expect(r).toMatchObject({ concluidas: 1 });
  });

  // ─── J06: a escrita do desfecho que o banco recusa não passa por espera normal ───

  it.each([
    ["a volta à fila (retida, com o motivo)", "channel_session_not_working", "pending"],
    ["a falha do envio incerto", null, "failed"],
  ] as const)(
    "J06 ⭐ o banco recusa %s: a rodada diz que ficou sem registro, deixa log, e o destinatário segue reservado",
    async (_caso, motivo, statusRecusado) => {
      const { tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
      const admin = fakeAdmin(tabelas, { recusar: (t, p) => t === "campaign_recipients" && p.status === statusRecusado });
      mundo.aoEnviar = async () => naFila(tabelas, "m-retida", motivo);
      const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
      expect(unica(tabelas, "campaign_recipients").status).toBe("sending");
      expect(r.detalhe).toBe("camp:fila:sem_registro");
      expect(mundo.erros).toEqual([
        ["[campanha] o desfecho da fila do canal não foi gravado", expect.objectContaining({ destinatario: "r-ana" })],
      ]);
    },
  );

  it("J06 o banco recusa a falha do envio incerto: o número conta como usado do mesmo jeito (a mensagem pode ter saído)", async () => {
    const tabelas = duasCampanhasNoVinculado();
    const admin = fakeAdmin(tabelas, { recusar: (t, p) => t === "campaign_recipients" && p.status === "failed" });
    mundo.aoEnviar = async () => naFila(tabelas, `m-${mundo.envios.length}`, null);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:vinculado"]);
  });

  it("J06 o banco recusa tirar a mensagem retida da fila física: deixa log, e a pessoa volta à fila da campanha (o resgate não manda prospecção)", async () => {
    const { tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const admin = fakeAdmin(tabelas, { recusar: (t, p) => t === "messages" && p.status === "failed" });
    mundo.aoEnviar = async () => naFila(tabelas, "m-retida");
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mensagemDe(tabelas, "m-retida")).toMatchObject({ status: "queued" });
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", last_error_code: "canal_indisponivel" });
    expect(r.detalhe).toBe("camp:fila:canal_indisponivel");
    expect(mundo.erros).toEqual([
      ["[campanha] a mensagem retida não saiu da fila física", expect.objectContaining({ mensagem: "m-retida" })],
    ]);
  });

  // ─── J05/J09: a tentativa que o canal segurou não gasta o teto do número ───

  it("J05 ⭐ a mensagem que o canal segurou (o handler não chamou o provedor) não entra no registro de envios do número", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => naFila(tabelas, "m-retida");
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.ledger.get("chip") ?? []).toEqual([]);
  });

  it("J05 controle: o envio incerto (pode ter saído) entra no registro do número; e, na campanha de consentimento, a retida também (o resgate a manda)", async () => {
    const incerto = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => naFila(incerto.tabelas, "m-incerta", null);
    await rodarUmaRodadaDeCampanha(incerto.admin, QUARTA);
    expect(mundo.ledger.get("chip")).toHaveLength(1);
    mundo.ledger.clear();
    const consentimento = cenario(campanha("consent"), pendente("ana"));
    mundo.aoEnviar = async () => naFila(consentimento.tabelas, "m-retida");
    await rodarUmaRodadaDeCampanha(consentimento.admin, QUARTA);
    expect(mundo.ledger.get("chip")).toHaveLength(1);
  });

  const comUmaVagaNoDia = (usadas: number) => {
    const c = cenario(campanha("legitimate_interest"), pendente("ana"));
    // Sem provider conhecido, o número conta como de risco (fail-closed de `canalTemRiscoDeBanimento`): o teto do
    // dia vale, sem nomear o provider fora de lib/channels/ (doutrina restricao-de-canal).
    Object.assign(c.tabelas.channel_sessions![0]!, { daily_message_limit: 60 });
    mundo.knobs = { ...mundo.knobs, warmupDailyCaps: [{ minAgeDays: 0, cap: null }] } as PacingKnobs;
    mundo.ledger.set("chip", Array.from({ length: usadas }, () => new Date(QUARTA.getTime() - 3_600_000)));
    return c;
  };

  it("J09 ⭐ com uma vaga no dia, a retenção não a gasta: o canal volta, e a pessoa recebe na rodada seguinte", async () => {
    const { tabelas, admin } = comUmaVagaNoDia(59);
    mundo.aoEnviar = async () => naFila(tabelas, "m-retida");
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
    mundo.aoEnviar = null;
    await rodarUmaRodadaDeCampanha(admin, new Date(QUARTA.getTime() + 120_000));
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent" });
  });

  it("J09 controle do cenário: com o teto do dia cheio (60 de 60), não sai", async () => {
    const { tabelas, admin } = comUmaVagaNoDia(60);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients").status).toBe("pending");
  });

  // ─── J04: o balão que não saiu, retido ou incerto, para os seguintes ───

  it("J04 ⭐ balões: o 1º voltou incerto (queued sem o motivo), e o 2º não sai: a incerteza não fica escondida atrás de um balão que saiu", async () => {
    const { tabelas, admin } = emBaloes();
    mundo.aoEnviar = async () => (mundo.envios.length === 1 ? naFila(tabelas, "m-1", null) : { id: "m-2", status: "sent" });
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "failed",
      last_error_code: "envio_incerto",
      message_id: "m-1",
    });
    expect(r).toMatchObject({ enviadas: 0 });
  });

  it("J04 balões: o 2º voltou incerto: o 3º não sai, e o destinatário fica com o envio incerto (o começo saiu)", async () => {
    const { tabelas, admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    mundo.aoEnviar = async () =>
      mundo.envios.length === 1 ? { id: "m-1", status: "sent" } : naFila(tabelas, `m-${mundo.envios.length}`, null);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toHaveLength(2);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({
      status: "failed",
      last_error_code: "envio_incerto",
      message_id: "m-1",
    });
    expect(mensagemDe(tabelas, "m-2")).toMatchObject({ status: "failed", error_code: "campanha_sem_reenvio" });
  });
});

describe("8. o contrato da revisão F4k do cxj (11/11/2026): a rajada que para por erro leva o que fez", () => {
  /** A campanha A em rajada (rápida, com modelo) e a B gradual; as duas só falam pelo vinculado comum. */
  const rajadaEGradualNoVinculado = (): Tabelas => {
    const tabelas = duasCampanhasNoVinculado();
    Object.assign(tabelas.campaigns!.find((c) => c.id === "camp-a")!, { velocidade: "rapida", message_mode: "template" });
    Object.assign(tabelas.campaign_recipients!.find((d) => d.id === "r-ana")!, { variables: { modelo: {} } });
    return tabelas;
  };
  /** O banco que recusa a N-ª leitura dos pendentes (a busca do lote), e só ela. */
  const recusaALeituraDosPendentes = (tabelas: Tabelas, qual: number) => {
    const inteiro = fakeAdmin(tabelas) as unknown as { from: (t: string) => Record<string, unknown> };
    let leituras = 0;
    return {
      from: (tabela: string) => {
        const consulta = inteiro.from(tabela);
        if (tabela !== "campaign_recipients") return consulta;
        return new Proxy(consulta, {
          get: (alvo, metodo) =>
            metodo === "select"
              ? (colunas: string, opcoes?: unknown) =>
                  colunas === COLUNAS_DO_DESTINATARIO && ++leituras === qual
                    ? cadeiaComErro("a leitura da fila falhou")
                    : (alvo.select as (c: string, o?: unknown) => unknown)(colunas, opcoes)
              : alvo[metodo as string],
        });
      },
    };
  };

  it("K08 ⭐ a rajada falou pelo vinculado e a leitura do 2º lote falhou: a rodada conta o envio, e a outra campanha não fala pelo vinculado", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(QUARTA);
    try {
      const tabelas = rajadaEGradualNoVinculado();
      const rodada = rodarUmaRodadaDeCampanha(recusaALeituraDosPendentes(tabelas, 2) as never, QUARTA);
      await vi.runAllTimersAsync();
      const r = await rodada;
      expect(mundo.envios).toEqual(["conv:ana:vinculado"]);
      expect(r.detalhe).toContain("camp-a:erro");
      expect(r.enviadas).toBe(1);
      expect(tabelas.campaign_recipients!.find((d) => d.id === "r-bia")).toMatchObject({ status: "pending" });
      expect(tabelas.campaigns!.find((c) => c.id === "camp-a")).toMatchObject({ status: "running" });
      // O log diz o erro e o que a rajada já tinha feito.
      expect(mundo.avisos).toEqual([
        [
          "[campanha] rodada falhou",
          {
            campanha: "camp-a",
            motivo: "a fila da campanha não foi lida: a leitura da fila falhou",
            parcial: "rajada:1(enviado×1):erro",
          },
        ],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("K08 controle: sem a falha, a rajada conclui, e a outra campanha também não fala pelo vinculado", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(QUARTA);
    try {
      const tabelas = rajadaEGradualNoVinculado();
      const rodada = rodarUmaRodadaDeCampanha(fakeAdmin(tabelas), QUARTA);
      await vi.runAllTimersAsync();
      const r = await rodada;
      expect(mundo.envios).toEqual(["conv:ana:vinculado"]);
      expect(r.enviadas).toBe(1);
      expect(tabelas.campaign_recipients!.find((d) => d.id === "r-bia")).toMatchObject({ status: "pending" });
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Ajudantes das revisões F4l e F4m: a rajada sozinha, o relógio falso, o ledger que recusa, a vaga no dia ───

/** A campanha A sozinha, em rajada (rápida, com modelo), falando só pelo vinculado, com estes pendentes. */
const rajadaSozinha = (...contatos: string[]): Tabelas => {
  const tabelas = duasCampanhasNoVinculado();
  tabelas.campaigns = tabelas.campaigns!.filter((c) => c.id === "camp-a");
  Object.assign(tabelas.campaigns[0]!, { velocidade: "rapida", message_mode: "template" });
  tabelas.campaign_recipients = contatos.map((contato) =>
    pendente(contato, ["funil-a"], { campaign_id: "camp-a", variables: { modelo: {} } }),
  );
  return tabelas;
};
/** A rodada com o relógio falso: a rajada espera entre um início e outro. */
const rodadaNoRelogio = async (admin: unknown) => {
  vi.useFakeTimers();
  vi.setSystemTime(QUARTA);
  try {
    const rodada = rodarUmaRodadaDeCampanha(admin as never, QUARTA);
    await vi.runAllTimersAsync();
    return await rodada;
  } finally {
    vi.useRealTimers();
  }
};
/** O INSERT da vaga no ledger do número, recusado pelo banco sempre ou quando `quando` disser. */
const ledgerRecusa = (quando: (numero: string) => boolean = () => true) => {
  mundo.aoRegistrar = (numero) => {
    if (quando(numero)) throw new Error("INSERT no ledger recusado");
  };
};
/** Só a 1ª tentativa de registro é recusada: a falha que passa (F4m, M01 do cxj). */
const ledgerRecusaUmaVez = () => {
  let tentativas = 0;
  ledgerRecusa(() => ++tentativas === 1);
};
/** O dia do chip com 59 de 60 usados, sem o degrau de aquecimento: só o limite do canal vale. */
const comUmaVagaNoChip = (tabelas: Tabelas) => {
  Object.assign(tabelas.channel_sessions!.find((s) => s.id === "chip")!, { daily_message_limit: 60 });
  mundo.knobs = { ...mundo.knobs, warmupDailyCaps: [{ minAgeDays: 0, cap: null }] } as PacingKnobs;
  mundo.ledger.set("chip", Array.from({ length: 59 }, () => new Date(QUARTA.getTime() - 3_600_000)));
};
/** Três rodadas seguidas, a um minuto uma da outra; devolve a soma dos enviados. */
const tresRodadas = async (admin: unknown) => {
  let enviadas = 0;
  for (let i = 0; i < 3; i++) {
    enviadas += (await rodarUmaRodadaDeCampanha(admin as never, new Date(QUARTA.getTime() + i * 60_000))).enviadas;
  }
  return enviadas;
};
/** A gradual com três pendentes e uma vaga no dia do chip (L06 e M01 do cxj). */
const gradualComUmaVaga = (opcoes: Parameters<typeof fakeAdmin>[1] = {}) => {
  const { tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
  tabelas.campaign_recipients!.push(pendente("bia"), pendente("caio"));
  comUmaVagaNoChip(tabelas);
  return { tabelas, admin: fakeAdmin(tabelas, opcoes) };
};

describe("9. os contratos da revisão F4l do cxj (11/11/2026): o envio fora do teto do número, o andamento que não se lê", () => {
  /**
   * O banco que devolve erro na 1ª leitura do status da campanha feita com `envios` envios já saídos. Na
   * rajada, a 1ª com 0 é a do andamento antes do 1º lote; a 1ª com 1 é a do andamento depois do 1º envio (a da
   * reserva, que também lê o status, vem antes do envio).
   */
  const andamentoComErro = (tabelas: Tabelas, envios: number) => {
    const inteiro = fakeAdmin(tabelas) as unknown as { from: (t: string) => Record<string, unknown> };
    let falhou = false;
    return {
      from: (tabela: string) => {
        const consulta = inteiro.from(tabela);
        if (tabela !== "campaigns") return consulta;
        return new Proxy(consulta, {
          get: (alvo, metodo) =>
            metodo === "select"
              ? (colunas: string, opcoes?: unknown) => {
                  if (colunas === "status" && !falhou && mundo.envios.length === envios) {
                    falhou = true;
                    return cadeiaComErro("andamento indisponível");
                  }
                  return (alvo.select as (c: string, o?: unknown) => unknown)(colunas, opcoes);
                }
              : alvo[metodo as string],
        });
      },
    };
  };

  // ─── L01: o andamento que não se lê não pode passar por “a campanha parou” ───

  it.each([
    [0, "rajada:0:erro"],
    [1, "rajada:1(enviado×1):erro"],
  ] as const)(
    "L01 ⭐ a leitura do andamento da rajada falha com %i envio(s) feito(s): a rodada diz erro, avisa o motivo, e a campanha segue em andamento",
    async (envios, parcial) => {
      const tabelas = rajadaSozinha("ana");
      const r = await rodadaNoRelogio(andamentoComErro(tabelas, envios));
      expect(r.detalhe).toContain("camp-a:erro");
      expect(r.enviadas).toBe(envios);
      expect(mundo.avisos).toEqual([
        [
          "[campanha] rodada falhou",
          { campanha: "camp-a", motivo: "o andamento da campanha não foi lido: andamento indisponível", parcial },
        ],
      ]);
      expect(unica(tabelas, "campaigns").status).toBe("running");
      expect(unica(tabelas, "campaigns").failure_code).toBeUndefined();
    },
  );

  it("L01 controle: a campanha pausada pela tela depois do 1º envio (lida sem erro) para a rajada sem aviso", async () => {
    const tabelas = rajadaSozinha("ana");
    mundo.aoEnviar = async () => void Object.assign(unica(tabelas, "campaigns"), { status: "paused" });
    const r = await rodadaNoRelogio(fakeAdmin(tabelas));
    expect(mundo.envios).toEqual(["conv:ana:vinculado"]);
    expect(mundo.avisos).toEqual([]);
    expect(r.detalhe).toContain("fora_de_andamento");
    expect(r.detalhe).not.toContain("erro");
  });

  // ─── L03/L06: o envio que sairia sem entrar no teto do número. Desde a F4m, ele não sai ───

  it("L03 ⭐ rajada: o ledger recusa a vaga do 1º envio: nada sai, todos seguem na fila, e a rajada para com o erro", async () => {
    const tabelas = rajadaSozinha("ana", "caio", "dora");
    ledgerRecusa();
    const r = await rodadaNoRelogio(fakeAdmin(tabelas));
    expect(mundo.envios).toEqual([]);
    expect(r).toMatchObject({ enviadas: 0, concluidas: 0 });
    expect(r.detalhe).toContain("camp-a:erro_no_teto");
    expect(unica(tabelas, "campaigns")).toMatchObject({ status: "running" });
    expect(unica(tabelas, "campaigns").failure_code).toBeUndefined();
    expect(tabelas.campaign_recipients![0]).toMatchObject({ status: "pending", sending_at: null });
    expect(tabelas.campaign_recipients!.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);
    expect(mundo.erros).toEqual([
      [
        "[campanha] o envio não saiu: o teto do número não registrou a vaga",
        { campanha: "camp-a", destinatario: "r-ana", numero: "vinculado", motivo: "INSERT no ledger recusado" },
      ],
    ]);
  });

  it("L06 ⭐ gradual com uma vaga no dia: o ledger recusa sempre: nada sai em três rodadas, e o teto do número fica inteiro", async () => {
    const { tabelas, admin } = gradualComUmaVaga();
    ledgerRecusa();
    const enviadas = await tresRodadas(admin);
    expect(mundo.envios).toEqual([]);
    expect(enviadas).toBe(0);
    expect(mundo.ledger.get("chip")).toHaveLength(59);
    expect(unica(tabelas, "campaigns")).toMatchObject({ status: "running" });
    expect(tabelas.campaign_recipients!.map((d) => d.status)).toEqual(["pending", "pending", "pending"]);
    expect(mundo.erros).toHaveLength(3);
  });

  it("L06 controle: sem a falha, o teto do número segura as outras duas, e a campanha segue em andamento", async () => {
    const { tabelas, admin } = gradualComUmaVaga();
    const enviadas = await tresRodadas(admin);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    expect(enviadas).toBe(1);
    expect(unica(tabelas, "campaigns")).toMatchObject({ status: "running" });
    expect(mundo.ledger.get("chip")).toHaveLength(60);
    expect(mundo.erros).toEqual([]);
  });

  it("L06 ⭐ o ledger recusa as vagas do chip: nenhuma campanha fala por ele, uma tentativa por rodada; a do outro número segue, e ninguém pausa", async () => {
    const outra = (contato: string, telefone: string, campanhaId: string) =>
      pendente(contato, ["funil-a"], { campaign_id: campanhaId, recipient_address: telefone }, { phone_number: telefone });
    const tabelas: Tabelas = {
      campaigns: [
        campanha("legitimate_interest", { id: "camp-a" }),
        campanha("legitimate_interest", { id: "camp-b", started_at: "2026-11-18T11:55:05.000Z" }),
        campanha("legitimate_interest", { id: "camp-c", channel_session_id: "outro" }),
        campanha("legitimate_interest", { id: "camp-z", status: "completed" }),
      ],
      campaign_recipients: [
        pendente("ana", ["funil-a"], { campaign_id: "camp-a" }),
        outra("bia", "+5588999991111", "camp-b"),
        outra("cleo", "+5588999992222", "camp-c"),
        outra("dani", "+5588999993333", "camp-c"),
      ],
      campaign_channel_sessions: [],
      channel_sessions: [
        { id: "chip", organization_id: "org-1", status: "WORKING", daily_message_limit: null },
        { id: "outro", organization_id: "org-1", status: "WORKING", daily_message_limit: null },
      ],
      campaign_suppressions: [],
      messages: [],
      crm_leads: [],
      conversations: [],
    };
    const tentativas: string[] = [];
    mundo.aoRegistrar = (numero) => {
      tentativas.push(numero);
      if (numero === "chip") throw new Error("INSERT no ledger recusado");
    };
    await rodarUmaRodadaDeCampanha(fakeAdmin(tabelas), QUARTA);
    await rodarUmaRodadaDeCampanha(fakeAdmin(tabelas), new Date(QUARTA.getTime() + 60_000));
    const daCampanha = (id: string) => tabelas.campaigns!.find((c) => c.id === id)!;
    // Uma tentativa pelo chip em cada rodada: a recusa ocupa o número, e a outra campanha dele não insiste.
    expect(tentativas.filter((n) => n === "chip")).toHaveLength(2);
    expect(mundo.envios.filter((e) => e.endsWith(":chip"))).toEqual([]);
    expect(mundo.envios).toEqual(["conv:cleo:outro", "conv:dani:outro"]);
    for (const c of tabelas.campaigns!) expect(c.failure_code).toBeUndefined();
    expect(daCampanha("camp-a").status).toBe("running");
    expect(daCampanha("camp-b").status).toBe("running");
    expect(daCampanha("camp-z").status).toBe("completed");
    expect(tabelas.campaign_recipients!.find((d) => d.id === "r-ana")).toMatchObject({ status: "pending" });
    expect(tabelas.campaign_recipients!.find((d) => d.id === "r-bia")).toMatchObject({ status: "pending" });
  });

  it.each(["legitimate_interest", "consent"] as const)(
    "⭐ balões (%s): o ledger recusa a vaga do 1º: nenhum balão sai, e a pessoa volta à fila",
    async (base) => {
      const { tabelas, admin } = cenario(
        campanha(base, { split_messages: true }),
        pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
      );
      ledgerRecusa();
      const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
      expect(mundo.envios).toEqual([]);
      expect(r).toMatchObject({ enviadas: 0, detalhe: "camp:erro_no_teto" });
      expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", sending_at: null });
      expect(unica(tabelas, "campaigns")).toMatchObject({ status: "running" });
      // O erro do banco não é vaga ocupada: o aviso genérico da falha vai ao log.
      expect(mundo.avisos).toContainEqual(["[campanha] envio falhou", { campanha: "camp", destinatario: "r-ana" }]);
    },
  );

  it("⭐ balões: o ledger registra o 1º e recusa a vaga do 2º: o 2º e o 3º não saem, e o destinatário conta como enviado pelo 1º", async () => {
    const { tabelas, admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    ledgerRecusa(() => mundo.envios.length === 1);
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toHaveLength(1);
    expect(r.enviadas).toBe(1);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent", message_id: "msg-1" });
    expect(unica(tabelas, "campaigns")).toMatchObject({ status: "running" });
    expect(mundo.ledger.get("chip")).toHaveLength(1);
    expect(mundo.erros).toEqual([
      [
        "[campanha] o balão seguinte não saiu: o teto do número não registrou a vaga",
        { campanha: "camp", destinatario: "r-ana", numero: "chip", balao: 1, motivo: "INSERT no ledger recusado" },
      ],
    ]);
    // A causa é o banco, e só ela vai ao log: nada de "vaga ocupada" por cima.
    expect(mundo.avisos.map((x) => x[0])).not.toContain(
      "[campanha] o balão seguinte não saiu: a vaga do número já foi ocupada",
    );
  });

  it("controle: na campanha de consentimento, o balão retido pelo canal não para os seguintes, como antes, e os dois ficam no teto (o resgate manda o retido)", async () => {
    const { tabelas, admin } = cenario(
      campanha("consent", { split_messages: true }),
      pendente("ana", ["funil-a"], { rendered_body: "Primeiro parágrafo.\n\nSegundo parágrafo." }),
    );
    mundo.aoEnviar = async () => (mundo.envios.length === 1 ? naFila(tabelas, "m-1") : undefined);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toHaveLength(2);
    expect(mundo.ledger.get("chip")).toHaveLength(2);
    expect(unica(tabelas, "campaigns")).toMatchObject({ status: "running" });
  });

  it("controle: com o ledger registrando, a campanha segue em andamento, sem motivo de pausa e sem log de erro", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(r.detalhe).toMatch(/^camp:enviado:sent:/);
    expect(unica(tabelas, "campaigns")).toMatchObject({ status: "running" });
    expect(unica(tabelas, "campaigns").failure_code).toBeUndefined();
    expect(mundo.erros).toEqual([]);
  });
});

describe("10. os contratos da revisão F4m do cxj (11/11/2026): nenhuma mensagem sai sem a vaga no teto do número; o desfecho que não se grava avisa", () => {
  // ─── M01: a vaga entra no ledger ANTES de o balão sair, e o teto não depende mais de pausa ───

  it.each(["legitimate_interest", "consent"] as const)(
    "M01 ⭐ (%s) quando o handler é chamado, a vaga do envio já está no ledger do número",
    async (base) => {
      const { admin } = cenario(campanha(base), pendente("ana"));
      const vistos: number[] = [];
      mundo.aoEnviar = async () => void vistos.push(mundo.ledger.get("chip")?.length ?? 0);
      await rodarUmaRodadaDeCampanha(admin, QUARTA);
      expect(vistos).toEqual([1]);
      expect(mundo.ledger.get("chip")).toHaveLength(1);
    },
  );

  it("M01 ⭐ balões: cada balão sai com a própria vaga já no ledger", async () => {
    const { admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    const vistos: number[] = [];
    mundo.aoEnviar = async () => void vistos.push(mundo.ledger.get("chip")?.length ?? 0);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(vistos).toEqual([1, 2, 3]);
  });

  it("M01 ⭐ uma vaga no dia, o ledger recusa uma vez e o banco recusa toda escrita na campanha: em três rodadas sai uma só, e o ledger fica igual ao que saiu", async () => {
    const { tabelas, admin } = gradualComUmaVaga({ recusar: (tabela) => tabela === "campaigns" });
    ledgerRecusaUmaVez();
    const enviadas = await tresRodadas(admin);
    expect(mundo.envios).toEqual(["conv:ana:chip"]);
    expect(enviadas).toBe(1);
    expect(mundo.ledger.get("chip")).toHaveLength(60);
    expect(tabelas.campaign_recipients!.map((d) => d.status)).toEqual(["sent", "pending", "pending"]);
  });

  it("M01 ⭐ duas campanhas no mesmo chip, uma vaga no dia, o ledger recusa uma vez e o banco recusa toda escrita nas campanhas: a outra não passa do teto", async () => {
    const tabelas: Tabelas = {
      campaigns: [
        campanha("legitimate_interest", { id: "camp-a" }),
        campanha("legitimate_interest", { id: "camp-b", started_at: "2026-11-18T11:55:05.000Z" }),
      ],
      campaign_recipients: [
        pendente("ana", ["funil-a"], { campaign_id: "camp-a" }),
        pendente(
          "bia",
          ["funil-a"],
          { campaign_id: "camp-b", recipient_address: "+5588999991111" },
          { phone_number: "+5588999991111" },
        ),
      ],
      campaign_channel_sessions: [],
      channel_sessions: [{ id: "chip", organization_id: "org-1", status: "WORKING", daily_message_limit: null }],
      campaign_suppressions: [],
      messages: [],
      crm_leads: [],
      conversations: [],
    };
    comUmaVagaNoChip(tabelas);
    ledgerRecusaUmaVez();
    await tresRodadas(fakeAdmin(tabelas, { recusar: (tabela) => tabela === "campaigns" }));
    expect(mundo.envios).toHaveLength(1);
    expect(mundo.ledger.get("chip")).toHaveLength(60);
  });

  it("M01 a rajada para no erro do teto, em vez de tentar a fila inteira", () => {
    expect(desfechoParaARajada("erro_no_teto")).toBe(true);
  });

  // ─── A vaga de quem certamente não recebeu volta ao ledger; a de quem pode ter recebido fica ───

  it("M01 a vaga de quem o handler vetou volta ao ledger: nada saiu", async () => {
    const { admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => {
      throw new VetoDaCampanhaError({ pular: "recusou_marketing" });
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.ledger.get("chip") ?? []).toEqual([]);
    expect(mundo.erros).toEqual([]);
  });

  it("M01 a vaga da organização que parou entre a leitura e o envio volta ao ledger, e a pessoa volta à fila", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => {
      throw new OrgNaoOperanteError("org-1", "suspended");
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.ledger.get("chip") ?? []).toEqual([]);
    // A reserva é solta (`sending_at` nulo), como em toda volta à fila e como na 1.101.0.
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", sending_at: null });
  });

  it("M01 balões: o handler veta o 2º: só a vaga do 1º fica no ledger, no instante do 1º", async () => {
    // Com pausa entre os balões, a vaga do 2º tem instante próprio: devolver a do 1º no lugar dela deixaria a
    // mesma contagem, mas o throttle do envio seguinte contaria de um balão que não saiu.
    mundo.knobs = { ...mundo.knobs, throttleMs: 40 };
    const { admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    mundo.aoEnviar = async () => {
      if (mundo.envios.length === 2) throw new VetoDaCampanhaError({ pular: "escreveu_depois_da_preparacao" });
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toHaveLength(2);
    // O instante do 1º é o que a reserva dele leu sob a trava (versão 15, F4t do cxj, T02), não o `agora` exato.
    expect(mundo.ledger.get("chip")).toEqual([mundo.reservas[0]!.quando]);
    expect(mundo.reservas[1]!.quando.getTime() - mundo.reservas[0]!.quando.getTime()).toBeGreaterThanOrEqual(30);
  });

  it("M01 balões: o canal segura o 2º: volta a vaga dele, e fica a do 1º, no instante do 1º", async () => {
    mundo.knobs = { ...mundo.knobs, throttleMs: 40 };
    const { tabelas, admin } = emBaloes("Um.\n\nDois.");
    mundo.aoEnviar = async () => (mundo.envios.length === 2 ? naFila(tabelas, "m-retida") : undefined);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toHaveLength(2);
    expect(mundo.ledger.get("chip")).toEqual([mundo.reservas[0]!.quando]);
    expect(mundo.reservas[1]!.quando.getTime() - mundo.reservas[0]!.quando.getTime()).toBeGreaterThanOrEqual(30);
  });

  it("M01 ⭐ cada balão entra no teto no instante em que sai: o 1º no relógio da rodada lido na reserva, os seguintes depois da pausa", async () => {
    // O throttle do próximo envio do número conta a partir da última vaga: com todas no `agora`, o destinatário
    // seguinte sairia a menos de `throttleMs` do último balão (a prova de tela da v5 mediu 941 ms). Desde a versão 15
    // (F4t do cxj, T02), o 1º também leva a hora que a reserva leu, e não o `agora` da rodada.
    mundo.knobs = { ...mundo.knobs, throttleMs: 40 };
    const { admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    const depoisDoAgora = (mundo.ledger.get("chip") ?? []).map((d) => d.getTime() - QUARTA.getTime());
    expect(depoisDoAgora).toHaveLength(3);
    expect(mundo.ledger.get("chip")).toEqual(mundo.reservas.map((r) => r.quando));
    expect(depoisDoAgora[0]).toBeGreaterThanOrEqual(0);
    expect(depoisDoAgora[1]! - depoisDoAgora[0]!).toBeGreaterThanOrEqual(30);
    expect(depoisDoAgora[1]).toBeGreaterThanOrEqual(30);
    expect(depoisDoAgora[2]! - depoisDoAgora[1]!).toBeGreaterThanOrEqual(30);
  });

  it("M01 o banco recusa devolver a vaga da mensagem que o canal segurou: a vaga fica (o lado seguro), e o erro vai ao log", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => naFila(tabelas, "m-retida");
    mundo.aoDesfazer = () => {
      throw new Error("DELETE no ledger recusado");
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.ledger.get("chip")).toHaveLength(1);
    expect(mundo.erros).toContainEqual([
      "[campanha] a vaga de um envio que não saiu ficou no teto do número",
      { campanha: "camp", destinatario: "r-ana", numero: "chip", motivo: "DELETE no ledger recusado" },
    ]);
  });

  it("M01 o handler lançou sem dizer se a mensagem saiu: a vaga fica no ledger (pode ter saído)", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => {
      throw new Error("o provedor caiu no meio do envio");
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.ledger.get("chip")).toHaveLength(1);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "failed", last_error_code: "send_exception" });
  });

  // ─── M02: o desfecho do destinatário que o banco recusa vai ao log ───

  const recusaODesfecho = (status: string) => (tabela: string, patch: Linha) =>
    tabela === "campaign_recipients" && patch.status === status;
  const RECUSA = "o banco recusou a escrita em campaign_recipients";

  it("M02 ⭐ o banco recusa gravar o desfecho de um envio que saiu: a rodada conta o envio, e o erro vai ao log com a mensagem", async () => {
    const { tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
    const r = await rodarUmaRodadaDeCampanha(fakeAdmin(tabelas, { recusar: recusaODesfecho("sent") }), QUARTA);
    expect(r.enviadas).toBe(1);
    expect(unica(tabelas, "campaign_recipients").status).toBe("sending");
    expect(mundo.erros).toEqual([
      [
        "[campanha] o desfecho do destinatário não foi gravado",
        { destinatario: "r-ana", status: "sent", codigo: null, mensagem: "msg-1", motivo: RECUSA },
      ],
    ]);
  });

  it.each([
    ["a falha do envio", async () => ({ id: "msg-1", status: "failed" }), "failed", "send_failed", "msg-1"],
    [
      "o pedido para desacelerar (429)",
      async () => ({ id: "msg-1", status: "failed", error_code: "429", error_message: "rate_limited" }),
      "pending",
      "limite_de_velocidade",
      null,
    ],
    [
      "a exceção do envio",
      async () => {
        throw new Error("o provedor caiu no meio do envio");
      },
      "failed",
      "send_exception",
      null,
    ],
  ] as const)("M02 ⭐ o banco recusa gravar %s: o erro vai ao log", async (_caso, enviar, status, codigo, mensagem) => {
    const { tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = enviar as unknown as typeof mundo.aoEnviar;
    await rodarUmaRodadaDeCampanha(fakeAdmin(tabelas, { recusar: recusaODesfecho(status) }), QUARTA);
    expect(unica(tabelas, "campaign_recipients").status).toBe("sending");
    expect(mundo.erros).toContainEqual([
      "[campanha] o desfecho do destinatário não foi gravado",
      { destinatario: "r-ana", status, codigo, mensagem, motivo: RECUSA },
    ]);
  });

  it("M02 o banco recusa devolver à fila quem não recebeu porque o teto não registrou a vaga: o erro vai ao log", async () => {
    const { tabelas } = cenario(campanha("legitimate_interest"), pendente("ana"));
    ledgerRecusa();
    await rodarUmaRodadaDeCampanha(fakeAdmin(tabelas, { recusar: recusaODesfecho("pending") }), QUARTA);
    expect(unica(tabelas, "campaign_recipients").status).toBe("sending");
    expect(mundo.envios).toEqual([]);
    expect(mundo.erros).toContainEqual([
      "[campanha] o desfecho do destinatário não foi gravado",
      { destinatario: "r-ana", status: "pending", codigo: null, mensagem: null, motivo: RECUSA },
    ]);
  });

  // ─── O que `gravarDesfecho` não pode perder ao centralizar as escritas (o arnês da v8) ───

  it("M02 o ack chegou antes da gravação do desfecho: o destinatário segue `delivered`, e a gravação não o rebaixa", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoEnviar = async () => {
      unica(tabelas, "campaign_recipients").status = "delivered"; // o trigger do ack, entre o envio e a gravação
    };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(unica(tabelas, "campaign_recipients").status).toBe("delivered");
  });

  it("M02 o desfecho é gravado só no destinatário do envio: outro `sending` da campanha, em voo, fica como está", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    tabelas.campaign_recipients!.push(
      pendente("bia", ["funil-a"], { status: "sending", sending_at: new Date(QUARTA.getTime() - 10_000).toISOString() }),
    );
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    const status = Object.fromEntries(tabelas.campaign_recipients!.map((d) => [d.id, d.status]));
    expect(status).toEqual({ "r-ana": "sent", "r-bia": "sending" });
  });

  it("M02 balões: o desfecho leva o `message_id` do 1º balão, o que o ack encontra", async () => {
    const { tabelas, admin } = emBaloes("Um.\n\nDois.");
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.envios).toHaveLength(2);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent", message_id: "msg-1" });
  });
});

describe("11. o contrato da revisão F4n do cxj (11/11/2026): a vaga só entra se ainda couber, sob a trava do número", () => {
  /** A gradual com três pendentes de telefones distintos e uma vaga no dia do chip (o cenário do N12). */
  const sobrepostas = () => {
    const { tabelas, admin } = gradualComUmaVaga();
    tabelas.campaign_recipients!.forEach((d, i) => {
      const telefone = "+" + "55" + "88" + "9".repeat(5) + String(1000 + i);
      d.recipient_address = telefone;
      (d.contacts as Linha).phone_number = telefone;
    });
    return { tabelas, admin };
  };
  /** A rodada A para na abertura da conversa; a B, um minuto depois, corre inteira nesse meio-tempo; depois a A segue. */
  const aAtrasada = async (admin: unknown) => {
    let entrou!: () => void;
    let soltar!: () => void;
    const dentro = new Promise<void>((ok) => (entrou = ok));
    const portao = new Promise<void>((ok) => (soltar = ok));
    let vezes = 0;
    mundo.aoAbrir = async () => {
      if (++vezes === 1) {
        entrou();
        await portao;
      }
    };
    const a = rodarUmaRodadaDeCampanha(admin as never, QUARTA);
    await dentro;
    let b;
    try {
      b = await rodarUmaRodadaDeCampanha(admin as never, new Date(QUARTA.getTime() + 60_000));
    } finally {
      soltar();
    }
    return { a: await a, b };
  };
  const comTetoDoCrm = (tabelas: Tabelas, limite: number | null, aquecimento: number | null = null) => {
    Object.assign(unica(tabelas, "channel_sessions"), { daily_message_limit: limite });
    mundo.knobs = { ...mundo.knobs, warmupDailyCaps: [{ minAgeDays: 0, cap: aquecimento }] } as PacingKnobs;
  };

  it("N12 ⭐ duas rodadas sobrepostas pela última vaga do chip: só uma manda, e o ledger fecha em 60", async () => {
    const { tabelas, admin } = sobrepostas();
    const { a, b } = await aAtrasada(admin);
    expect(b.enviadas).toBe(1);
    expect(a).toMatchObject({ enviadas: 0 });
    expect(a.detalhe).toContain("canal:teto_cheio");
    expect({ saidas: mundo.envios.length + 59, ledger: mundo.ledger.get("chip")!.length }).toEqual({ saidas: 60, ledger: 60 });
    // A atrasada não mandou: ana volta à fila, sem reserva, e sai num dia com vaga.
    expect(tabelas.campaign_recipients!.map((d) => [d.id, d.status, d.sending_at ?? null])).toEqual([
      ["r-ana", "pending", null],
      ["r-bia", "sent", expect.any(String)],
      ["r-caio", "pending", null],
    ]);
    // Não é erro do banco nem falha do envio: um aviso próprio, e nada em `logger.error`.
    expect(mundo.erros).toEqual([]);
    expect(mundo.avisos).toContainEqual([
      "[campanha] o envio não saiu: a vaga do número já foi ocupada",
      expect.objectContaining({ destinatario: "r-ana", numero: "chip", motivo: "teto_cheio" }),
    ]);
    expect(mundo.avisos.map((x) => x[0])).not.toContain("[campanha] envio falhou");
  });

  it("N12 controle: as mesmas duas rodadas em sequência mandam uma só, e a 2ª nem reserva a pessoa", async () => {
    const { tabelas, admin } = sobrepostas();
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    const b = await rodarUmaRodadaDeCampanha(admin, new Date(QUARTA.getTime() + 60_000));
    expect(b.detalhe).toContain("canal:sem_numero_livre");
    expect(mundo.envios).toHaveLength(1);
    expect(mundo.ledger.get("chip")).toHaveLength(60);
    expect(mundo.reservas).toHaveLength(1);
    expect(tabelas.campaign_recipients!.map((d) => d.status)).toEqual(["sent", "pending", "pending"]);
  });

  it("N12 com folga no teto, a rodada atrasada esbarra no intervalo do chip e volta à fila", async () => {
    const { tabelas, admin } = sobrepostas();
    mundo.ledger.set("chip", []);
    mundo.knobs = { ...mundo.knobs, throttleMs: 5_000 };
    const { a, b } = await aAtrasada(admin);
    expect(b.enviadas).toBe(1);
    expect(a.detalhe).toContain("canal:intervalo");
    expect(mundo.envios).toHaveLength(1);
    // A vaga da B, a 1ª reserva, no instante que a reserva dela leu (versão 15, F4t do cxj, T02).
    expect(mundo.ledger.get("chip")).toEqual([mundo.reservas[0]!.quando]);
    expect(mundo.reservas[0]!.quando.getTime()).toBeGreaterThanOrEqual(QUARTA.getTime() + 60_000);
    expect(tabelas.campaign_recipients![0]).toMatchObject({ status: "pending", sending_at: null });
    expect(mundo.avisos).toContainEqual([
      "[campanha] o envio não saiu: a vaga do número já foi ocupada",
      expect.objectContaining({ destinatario: "r-ana", motivo: "intervalo" }),
    ]);
  });

  it("N12 a vaga leva a regra do chip: o teto, o dia no fuso do número, todos os balões e o intervalo sem o jitter (mais a folga da vaga) no 1º; uma vaga e sem intervalo nos seguintes", async () => {
    const { tabelas, admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    comTetoDoCrm(tabelas, 60);
    mundo.knobs = { ...mundo.knobs, throttleMs: 1_500, jitterMaxMs: 800 };
    await rodadaNoRelogio(admin);
    const desde = dayStartInTz(QUARTA, mundo.knobs.timezone);
    expect(mundo.envios).toHaveLength(3);
    expect(mundo.reservas.map((r) => r.regra)).toEqual([
      // Mais a folga da vaga (versão 15, F4t do cxj, T03).
      { limite: 60, desde, vagas: 3, intervaloMs: 1_500 + FOLGA_DA_VAGA },
      { limite: 60, desde, vagas: 1, intervaloMs: 0 },
      { limite: 60, desde, vagas: 1, intervaloMs: 0 },
    ]);
  });

  it.each([
    [60, 10, 10],
    [8, 10, 8],
    [null, 25, 25],
    [null, null, null],
  ] as const)("N12 o teto da vaga é o menor entre o limite do CRM (%s) e o aquecimento (%s): %s", async (crm, aquecimento, limite) => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    comTetoDoCrm(tabelas, crm, aquecimento);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.reservas.map((r) => r.regra.limite)).toEqual([limite]);
  });

  it("N12 número sem risco de banimento: a vaga não tem teto nem intervalo, como no `decidePacing`", async () => {
    const semRisco = PROVIDERS_DE_MENSAGEM.find((p) => !canalTemRiscoDeBanimento(p));
    expect(semRisco).toBeDefined();
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest", { message_mode: "template" }),
      pendente("ana", ["funil-a"], { variables: { modelo: {} } }),
    );
    comTetoDoCrm(tabelas, 60, 10);
    Object.assign(unica(tabelas, "channel_sessions"), { provider: semRisco });
    mundo.knobs = { ...mundo.knobs, throttleMs: 1_500 };
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.reservas.map((r) => r.regra)).toEqual([
      { limite: null, desde: dayStartInTz(QUARTA, mundo.knobs.timezone), vagas: 1, intervaloMs: 0 },
    ]);
  });

  it("N12 número sem risco de banimento: o aquecimento e o intervalo de chip não o tiram da rodada, como no `decidePacing`", async () => {
    const semRisco = PROVIDERS_DE_MENSAGEM.find((p) => !canalTemRiscoDeBanimento(p));
    expect(semRisco).toBeDefined();
    const { tabelas, admin } = cenario(
      campanha("legitimate_interest", { message_mode: "template" }),
      pendente("ana", ["funil-a"], { variables: { modelo: {} } }),
    );
    comTetoDoCrm(tabelas, null, 5);
    Object.assign(unica(tabelas, "channel_sessions"), { provider: semRisco });
    mundo.knobs = { ...mundo.knobs, throttleMs: 5_000 };
    // Dez envios hoje, o último há 1 s: acima do aquecimento e dentro do intervalo de um chip por QR.
    mundo.ledger.set("chip", Array.from({ length: 10 }, (_, i) => new Date(QUARTA.getTime() - 10_000 + i * 1_000)));
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(r.enviadas).toBe(1);
    expect(mundo.envios).toHaveLength(1);
  });

  it("N12 o aquecimento da vaga conta a idade do número: ativado há 30 dias, vale o degrau dos 14 dias", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    Object.assign(unica(tabelas, "channel_sessions"), { daily_message_limit: 60 });
    mundo.knobs = {
      ...mundo.knobs,
      warmupDailyCaps: [
        { minAgeDays: 0, cap: 5 },
        { minAgeDays: 14, cap: 40 },
      ],
    } as PacingKnobs;
    mundo.ativadoEm = new Date(QUARTA.getTime() - 30 * 86_400_000);
    await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(mundo.reservas.map((r) => r.regra.limite)).toEqual([40]);
  });

  it("N12 no rodízio, a vaga leva a regra do número que fala, e não a do principal", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    Object.assign(unica(tabelas, "channel_sessions"), { daily_message_limit: 60 });
    // O principal falou há 1 s e está no intervalo; quem fala é o vinculado, com teto próprio.
    tabelas.channel_sessions!.push({ id: "vinculado", organization_id: "org-1", status: "WORKING", daily_message_limit: 10 });
    tabelas.campaign_channel_sessions!.push({ organization_id: "org-1", campaign_id: "camp", channel_session_id: "vinculado" });
    mundo.knobs = { ...mundo.knobs, throttleMs: 5_000, warmupDailyCaps: [{ minAgeDays: 0, cap: null }] } as PacingKnobs;
    mundo.ledger.set("chip", [new Date(QUARTA.getTime() - 1_000)]);
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(r.enviadas).toBe(1);
    expect(mundo.reservas.map((x) => [x.numero, x.regra.limite, x.regra.intervaloMs])).toEqual([
      ["vinculado", 10, 5_000 + FOLGA_DA_VAGA],
    ]);
  });

  it("N12 sem vaga para a mensagem inteira, o 1º balão não sai: ninguém recebe meia mensagem", async () => {
    const { tabelas, admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    comTetoDoCrm(tabelas, 60);
    mundo.ledger.set("chip", Array.from({ length: 57 }, () => new Date(QUARTA.getTime() - 3_600_000)));
    // Entre a leitura da rodada e a reserva, outro envio do chip leva uma vaga: sobram duas para três balões.
    mundo.aoAbrir = () => void mundo.ledger.get("chip")!.push(new Date(QUARTA.getTime() - 1_000));
    const r = await rodadaNoRelogio(admin);
    expect(r.detalhe).toContain("canal:teto_cheio");
    expect(mundo.envios).toEqual([]);
    expect(mundo.ledger.get("chip")).toHaveLength(58);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", sending_at: null });
  });

  it("N12 balão seguinte sem vaga: o começo conta, o resto não vai, e a pessoa fica com o 1º", async () => {
    const { tabelas, admin } = emBaloes("Um.\n\nDois.\n\nTrês.");
    comTetoDoCrm(tabelas, 60);
    mundo.ledger.set("chip", Array.from({ length: 57 }, () => new Date(QUARTA.getTime() - 3_600_000)));
    // Enquanto o 1º balão sai, outros envios do chip levam as duas últimas vagas.
    mundo.aoEnviar = async () => {
      if (mundo.envios.length === 1) {
        mundo.ledger.get("chip")!.push(new Date(QUARTA.getTime() - 2_000), new Date(QUARTA.getTime() - 1_000));
      }
    };
    const r = await rodadaNoRelogio(admin);
    expect(r.enviadas).toBe(1);
    expect(mundo.envios).toHaveLength(1);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "sent", message_id: "msg-1" });
    expect(mundo.avisos).toContainEqual([
      "[campanha] o balão seguinte não saiu: a vaga do número já foi ocupada",
      { campanha: "camp", destinatario: "r-ana", numero: "chip", balao: 1, motivo: "teto_cheio" },
    ]);
    expect(mundo.erros).toEqual([]);
  });

  it("N12 na rajada, a vaga ocupada para a rajada, e a pessoa volta à fila", async () => {
    expect(desfechoParaARajada("canal:teto_cheio")).toBe(true);
    expect(desfechoParaARajada("canal:intervalo")).toBe(true);
    const tabelas = rajadaSozinha("ana", "bia");
    Object.assign(tabelas.channel_sessions!.find((s) => s.id === "vinculado")!, { daily_message_limit: 2 });
    mundo.knobs = { ...mundo.knobs, warmupDailyCaps: [{ minAgeDays: 0, cap: null }] } as PacingKnobs;
    // Entre a leitura e a reserva, outros envios do número levam as duas vagas do dia.
    mundo.aoAbrir = () => {
      if (!mundo.ledger.has("vinculado")) {
        mundo.ledger.set("vinculado", [new Date(QUARTA.getTime() - 2_000), new Date(QUARTA.getTime() - 1_000)]);
      }
    };
    const r = await rodadaNoRelogio(fakeAdmin(tabelas));
    expect(r.detalhe).toContain("canal:teto_cheio");
    expect(mundo.envios).toEqual([]);
    expect(mundo.reservas).toHaveLength(1);
    expect(tabelas.campaign_recipients!.map((d) => d.status)).toEqual(["pending", "pending"]);
  });

  it("N12 controle: o erro da reserva (o banco, ou a trava que não veio no prazo) segue o caminho da 8", async () => {
    const { tabelas, admin } = cenario(campanha("legitimate_interest"), pendente("ana"));
    mundo.aoRegistrar = () => {
      throw new Error("canceling statement due to lock timeout");
    };
    const r = await rodarUmaRodadaDeCampanha(admin, QUARTA);
    expect(r.detalhe).toContain("erro_no_teto");
    expect(mundo.envios).toEqual([]);
    expect(unica(tabelas, "campaign_recipients")).toMatchObject({ status: "pending", sending_at: null });
    expect(mundo.erros).toContainEqual([
      "[campanha] o envio não saiu: o teto do número não registrou a vaga",
      expect.objectContaining({ motivo: "canceling statement due to lock timeout" }),
    ]);
  });
});
