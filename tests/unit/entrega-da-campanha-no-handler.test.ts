/**
 * A CONFERÊNCIA FINAL DA CAMPANHA DENTRO DO HANDLER (revisão F4g do cxj, 11/11/2026).
 *
 * A3: a rodada confere a pessoa logo antes de chamar o handler, mas o handler
 * ainda leva tempo até o efeito do provedor. Com a entrega da campanha no
 * contexto, ele confere de novo no começo e no instante do efeito, como já faz
 * com a prospecção do agente.
 *
 * A5: a campanha de prospecção manda para o número aprovado na preparação, e
 * não para o LID nem para o telefone extra da última mensagem recebida, que a
 * preparação não conferiu.
 *
 * A conferência em si (o que veta) tem os testes dela em
 * `lib/campanhas/travas-da-prospeccao.test.ts`; aqui ela é trocada por uma
 * fila de vetos, para provar o que o HANDLER faz com cada resposta.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type * as Entrega from "@/lib/campanhas/entrega";
import { VetoDaCampanhaError, assertCampaignDelivery, type VetoDaCampanha } from "@/lib/campanhas/entrega";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";
import { redriveQueued } from "@/lib/agent-engine/edge/crm/session-reconciler";

const conferencia = vi.hoisted(() => ({
  vetos: [] as Array<unknown>,
  chamadas: 0,
  /** Roda antes de o veto subir: o meio do caminho em que outro caminho mexe na linha. */
  antesDoVeto: null as null | (() => void),
}));
vi.mock("@/lib/campanhas/entrega", async (original) => {
  const real = await original<typeof Entrega>();
  return {
    ...real,
    assertCampaignDelivery: vi.fn(async () => {
      const veto = conferencia.vetos[conferencia.chamadas++];
      if (veto) {
        conferencia.antesDoVeto?.();
        throw new real.VetoDaCampanhaError(veto as VetoDaCampanha);
      }
    }),
  };
});
// A ficha tem telefone extra, e a última mensagem recebida veio por ele.
vi.mock("@/lib/channels/endereco-da-ultima-recebida", () => ({
  enderecoDaUltimaRecebida: vi.fn(async () => "5588777770000@c.us"),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ storage: { from: () => ({}) } }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
const registro = vi.hoisted(() => ({ erros: [] as unknown[][] }));
vi.mock("@/lib/logger", () => ({
  logger: { info: () => {}, warn: () => {}, error: (...args: unknown[]) => void registro.erros.push(args) },
}));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const APROVADO = "+5588999990000";
const boundary = {
  organization_id: ORG,
  contact_id: CONTACT,
  conversation_id: CONV,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};
const entrega = { organizationId: ORG, campaignId: "camp", recipientId: "r-ana", destinoAprovado: APROVADO };

function montar() {
  const conversation = {
    ...boundary,
    id: CONV,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    // O contato tem LID (escreveu um dia) e o mesmo número aprovado na preparação.
    contacts: { phone_number: APROVADO, wa_identity: "lid:123456789", wa_lid: "123456789", is_blocked: false, is_personal: false },
    channel_sessions: { provider: "waha", waha_session_name: "ficticia", status: "WORKING" },
  };
  const duble = criarDubleDoHandler({ conversation, rpcData: { ...boundary, status: "open", demanda_fechada_em: null } });
  const destinos: string[] = [];
  vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:3030");
  vi.stubEnv("WAHA_API_KEY", "ficticia");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).endsWith("/sendText")) destinos.push(String(JSON.parse(String(init?.body ?? "{}")).chatId));
      return Response.json({ id: { id: "FICTICIA" } });
    }),
  );
  return { ...duble, destinos };
}

const ctx = (comEntrega: boolean, ator = "campaign:camp"): HandlerCtx => ({
  organization_id: ORG,
  actor: { type: "webhook_source", id: ator },
  requestId: "campaign:camp:r-ana",
  serviceBoundary: boundary,
  proactiveContext: { organizationId: ORG, contactId: CONTACT },
  ...(comEntrega ? { campaignDelivery: entrega } : {}),
});
const texto = {
  conversation_id: CONV,
  type: "text",
  body: "Texto fictício",
  metadata: { source: "campaign", campaign_id: "camp", campaign_recipient_id: "r-ana" },
} as SendMessageInput;

beforeEach(() => {
  conferencia.vetos = [];
  conferencia.chamadas = 0;
  conferencia.antesDoVeto = null;
  registro.erros.length = 0;
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendMessageHandler × entrega de campanha (F4g)", () => {
  it("A5 ⭐ o envio da campanha vai para o número aprovado, e não para o LID nem para o telefone extra", async () => {
    const { supabase, destinos } = montar();
    await sendMessageHandler(supabase, ctx(true), texto);
    expect(destinos).toEqual(["5588999990000@c.us"]);
  });

  // Desde a F4i, o envio do ator `campaign:<id>` sem a entrega é montado pelo handler (ver o bloco F4i abaixo); o
  // controle do destino de sempre é o envio que não é de campanha.
  it("controle: envio que não é de campanha, o destino é o de sempre (o telefone extra da última recebida)", async () => {
    const { supabase, destinos } = montar();
    await sendMessageHandler(supabase, ctx(false, "followup:inscricao"), texto);
    expect(destinos).toEqual(["5588777770000@c.us"]);
  });

  it("A3 ⭐ o veto no começo do handler: nada sai, nenhuma linha nasce, e o erro sobe", async () => {
    conferencia.vetos = [{ pular: "recusou_marketing" }];
    const { supabase, destinos, mensagens } = montar();
    const erro = await sendMessageHandler(supabase, ctx(true), texto).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VetoDaCampanhaError);
    expect(destinos).toEqual([]);
    expect(mensagens).toHaveLength(0);
  });

  it("A3 ⭐ o veto no instante do efeito: nada sai, a linha fica `failed` com `campanha_vetada`, e o erro sobe", async () => {
    conferencia.vetos = [null, { pular: "atendimento_humano" }];
    const { supabase, destinos, mensagens } = montar();
    const erro = await sendMessageHandler(supabase, ctx(true), texto).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VetoDaCampanhaError);
    expect((erro as VetoDaCampanhaError).veto).toEqual({ pular: "atendimento_humano" });
    expect(destinos).toEqual([]);
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({ status: "failed", error_code: "campanha_vetada" });
  });

  it("A3 ⭐ o veto no efeito não rebaixa a linha que outro caminho já avançou: só tira de `queued`", async () => {
    conferencia.vetos = [null, { pular: "atendimento_humano" }];
    const { supabase, destinos, mensagens } = montar();
    conferencia.antesDoVeto = () => {
      if (mensagens[0]) mensagens[0].status = "sent";
    };
    const erro = await sendMessageHandler(supabase, ctx(true), texto).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VetoDaCampanhaError);
    expect(destinos).toEqual([]);
    expect(mensagens[0]).toMatchObject({ status: "sent" });
  });

  it("controle: sem veto, a conferência roda no começo e no efeito, e sai uma vez", async () => {
    const { supabase, destinos } = montar();
    await sendMessageHandler(supabase, ctx(true), texto);
    expect(destinos).toHaveLength(1);
    expect(conferencia.chamadas).toBeGreaterThanOrEqual(2);
  });
});

/**
 * F4i do cxj (11/11/2026), H08: o UPDATE que tira a mensagem vetada de `queued` podia falhar em silêncio, e a linha
 * ficava na fila física, ao alcance do resgate do watchdog. Agora o handler tenta de novo, diz no log quando não
 * consegue, e o resgate não manda mensagem de campanha de prospecção (ver `session-reconciler.ts`).
 */
describe("sendMessageHandler × o veto que não consegue ser gravado (F4i, H08)", () => {
  /** O banco recusa as próximas `vezes` tentativas de marcar a mensagem como vetada. */
  function recusarOVeto(supabase: { from: (t: string) => unknown }, vezes: number) {
    const original = supabase.from.bind(supabase);
    let restantes = vezes;
    supabase.from = ((tabela: string) => {
      const consulta = original(tabela) as Record<string, unknown>;
      if (tabela !== "messages") return consulta;
      return new Proxy(consulta, {
        get: (alvo, metodo) => {
          if (metodo !== "update") return alvo[metodo as string];
          return (patch: Record<string, unknown>) => {
            if (patch.error_code !== "campanha_vetada" || restantes <= 0) {
              return (alvo.update as (p: Record<string, unknown>) => unknown)(patch);
            }
            restantes -= 1;
            const cadeia: Record<string, unknown> = {
              eq: () => cadeia,
              select: () => cadeia,
              maybeSingle: async () => ({ data: null, error: { message: "banco indisponível" } }),
            };
            return cadeia;
          };
        },
      });
    }) as typeof supabase.from;
  }

  it("⭐ a 1ª tentativa de tirar de `queued` falha e a 2ª grava: a linha fica `failed`, nada sai, e o erro sobe", async () => {
    conferencia.vetos = [null, { pular: "recusou_marketing" }];
    const { supabase, destinos, mensagens } = montar();
    recusarOVeto(supabase as never, 1);
    const erro = await sendMessageHandler(supabase, ctx(true), texto).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VetoDaCampanhaError);
    expect(destinos).toEqual([]);
    expect(mensagens[0]).toMatchObject({ status: "failed", error_code: "campanha_vetada" });
    expect(registro.erros).toEqual([]);
  });

  it("H08 ⭐ o banco recusa as duas tentativas: o erro sobe, o log diz qual mensagem, e o resgate do watchdog não a manda", async () => {
    conferencia.vetos = [null, { pular: "recusou_marketing" }];
    const { supabase, destinos, mensagens } = montar();
    recusarOVeto(supabase as never, 2);
    const erro = await sendMessageHandler(supabase, ctx(true), texto).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VetoDaCampanhaError);
    expect(destinos).toEqual([]);
    expect(mensagens[0]).toMatchObject({ status: "queued" });
    expect(registro.erros).toHaveLength(1);
    expect(registro.erros[0]![1]).toMatchObject({ message_id: mensagens[0]!.id });

    // O resgate do watchdog acha a linha na fila física: é de campanha de prospecção, e não sai.
    const consultas: string[] = [];
    const query = async (sql: string) => {
      consultas.push(sql);
      if (/select\s+m\.id/i.test(sql)) {
        return { rows: [{ ...mensagens[0], waha_session_name: "ficticia", phone_number: APROVADO, wa_identity: null,
          wa_lid: null, is_group: false, group_chat_id: null }] };
      }
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "0" }] };
      if (/select\s+s\.metadata/i.test(sql)) return { rows: [{ metadata: {}, phone_number: APROVADO, operante: true }] };
      if (/from campaigns/i.test(sql)) return { rows: [{ base_legal: "legitimate_interest" }] };
      return { rows: [] };
    };
    const reenviadas = await redriveQueued(
      { query } as never,
      { wahaBaseUrl: "http://127.0.0.1:3030", wahaApiKey: "ficticia", intervalMs: 1, redriveMinAgeMs: 0,
        redriveBatchSize: 1, redriveSpacingMs: 0 },
      { info: () => {}, warn: () => {}, error: () => {} } as never,
    );
    expect(reenviadas).toBe(0);
    expect(destinos).toEqual([]);
    expect(consultas.some((sql) => sql.includes("error_code = 'campanha_sem_reenvio'"))).toBe(true);
  });
});

/**
 * F4i do cxj (11/11/2026), H06/H07: a rodada passa a entrega em todo balão, mas o handler não pode depender disso. O
 * envio do ator `campaign:<id>` (que só a rodada cria) que chegar sem a entrega é montado aqui, pela campanha e pelo
 * destinatário do metadata: a conferência final roda no começo e no efeito, e o destino é o congelado.
 */
describe("sendMessageHandler × envio de campanha sem a entrega no contexto (F4i, H06/H07)", () => {
  /** PostgREST mínimo para as duas leituras da entrega montada: `eq` e `maybeSingle`. */
  function consulta(linhas: Array<Record<string, unknown>>, erro: string | null = null) {
    const filtros: Array<[string, unknown]> = [];
    const cadeia: Record<string, unknown> = {
      select: () => cadeia,
      eq: (coluna: string, valor: unknown) => (filtros.push([coluna, valor]), cadeia),
      maybeSingle: async () =>
        erro
          ? { data: null, error: { message: erro } }
          : { data: linhas.find((l) => filtros.every(([c, v]) => l[c] === v)) ?? null, error: null },
    };
    return cadeia;
  }
  function comCampanha(
    supabase: { from: (t: string) => unknown },
    base: string | null,
    opcoes: { erroDaCampanha?: string } = {},
  ) {
    const original = supabase.from.bind(supabase);
    supabase.from = ((tabela: string) => {
      if (tabela === "campaigns") {
        return consulta(base === null ? [] : [{ id: "camp", organization_id: ORG, base_legal: base }], opcoes.erroDaCampanha ?? null);
      }
      if (tabela === "campaign_recipients") {
        return consulta([{ id: "r-ana", campaign_id: "camp", recipient_address: ` ${APROVADO} ` }]);
      }
      return original(tabela);
    }) as typeof supabase.from;
  }
  const conferidas = () => (assertCampaignDelivery as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[1]);
  beforeEach(() => (assertCampaignDelivery as unknown as { mockClear: () => void }).mockClear());

  it("H07 ⭐ prospecção sem a entrega: o handler a monta pelo ator, confere no começo e no efeito, e manda só para o número aprovado", async () => {
    const { supabase, destinos } = montar();
    comCampanha(supabase as never, "legitimate_interest");
    await sendMessageHandler(supabase, ctx(false), texto);
    expect(destinos).toEqual(["5588999990000@c.us"]);
    // No começo e a cada corte do efeito (como o controle de cima), sempre com a entrega montada.
    expect(conferidas().length).toBeGreaterThanOrEqual(2);
    for (const entrega of conferidas()) {
      expect(entrega).toEqual({ organizationId: ORG, campaignId: "camp", recipientId: "r-ana", destinoAprovado: APROVADO });
    }
  });

  it("H06 ⭐ prospecção sem a entrega: o veto no instante do efeito barra, e nada sai", async () => {
    conferencia.vetos = [null, { pular: "escreveu_depois_da_preparacao" }];
    const { supabase, destinos, mensagens } = montar();
    comCampanha(supabase as never, "legitimate_interest");
    const erro = await sendMessageHandler(supabase, ctx(false), texto).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(VetoDaCampanhaError);
    expect(destinos).toEqual([]);
    expect(mensagens[0]).toMatchObject({ status: "failed", error_code: "campanha_vetada" });
  });

  it("controle: campanha de consentimento sem a entrega segue como antes: sem conferência, o destino de sempre", async () => {
    const { supabase, destinos } = montar();
    comCampanha(supabase as never, "consent");
    await sendMessageHandler(supabase, ctx(false), texto);
    expect(destinos).toEqual(["5588777770000@c.us"]);
    expect(conferidas()).toEqual([]);
  });

  it("controle: o envio de TESTE da campanha (`campaign-test:`) não é envio a lead, e segue como antes", async () => {
    const { supabase, destinos } = montar();
    comCampanha(supabase as never, "legitimate_interest");
    await sendMessageHandler(supabase, ctx(false, "campaign-test:camp"), texto);
    expect(destinos).toEqual(["5588777770000@c.us"]);
    expect(conferidas()).toEqual([]);
  });

  it.each([
    ["a campanha não se lê", { base: "legitimate_interest", erroDaCampanha: "banco indisponível" }],
    ["a campanha não se acha", { base: null }],
  ] as const)("⭐ %s: não manda (falha fechada), e nenhuma linha nasce", async (_nome, caso) => {
    const { supabase, destinos, mensagens } = montar();
    comCampanha(supabase as never, caso.base, "erroDaCampanha" in caso ? { erroDaCampanha: caso.erroDaCampanha } : {});
    const erro = await sendMessageHandler(supabase, ctx(false), texto).catch((e: unknown) => e);
    expect((erro as VetoDaCampanhaError).veto).toEqual({ esperar: "sem_leitura" });
    expect(destinos).toEqual([]);
    expect(mensagens).toHaveLength(0);
  });

  it("⭐ prospecção sem o destinatário no metadata: não manda", async () => {
    const { supabase, destinos } = montar();
    comCampanha(supabase as never, "legitimate_interest");
    const semDestinatario = { ...texto, metadata: { source: "campaign", campaign_id: "camp" } } as SendMessageInput;
    const erro = await sendMessageHandler(supabase, ctx(false), semDestinatario).catch((e: unknown) => e);
    expect((erro as VetoDaCampanhaError).veto).toEqual({ esperar: "sem_leitura" });
    expect(destinos).toEqual([]);
  });

  it("⭐ prospecção cujo destinatário não se acha: não manda", async () => {
    const { supabase, destinos } = montar();
    comCampanha(supabase as never, "legitimate_interest");
    const outro = { ...texto, metadata: { source: "campaign", campaign_id: "camp", campaign_recipient_id: "r-bia" } } as SendMessageInput;
    const erro = await sendMessageHandler(supabase, ctx(false), outro).catch((e: unknown) => e);
    expect((erro as VetoDaCampanhaError).veto).toEqual({ esperar: "sem_leitura" });
    expect(destinos).toEqual([]);
  });
});
