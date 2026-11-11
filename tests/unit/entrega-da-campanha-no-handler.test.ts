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
import { VetoDaCampanhaError, type VetoDaCampanha } from "@/lib/campanhas/entrega";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

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
vi.mock("@/lib/logger", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

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

const ctx = (comEntrega: boolean): HandlerCtx => ({
  organization_id: ORG,
  actor: { type: "webhook_source", id: "campaign:camp" },
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

  it("controle: sem a entrega de campanha, o destino é o de sempre (o telefone extra da última recebida)", async () => {
    const { supabase, destinos } = montar();
    await sendMessageHandler(supabase, ctx(false), texto);
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
