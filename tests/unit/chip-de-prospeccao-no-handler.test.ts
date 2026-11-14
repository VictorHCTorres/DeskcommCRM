/**
 * O NÚMERO DE PROSPECÇÃO NO HANDLER DE MENSAGENS (Linha A, v20).
 *
 * A automação (o follow-up de texto fixo, inclusive o da inscrição `dormente` que acordou), a integração por token
 * e o agente externo saem pelo handler sem passar pela cadeia do agente. No número de uma campanha de prospecção,
 * eles passam pela hora da prospecção (janela e dias do número, feriado nacional) e pela pessoa. O dublê é o
 * compartilhado (`tests/helpers/duble-do-handler.ts`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { comSaidaDoAgente, novaSaidaDoAgente } from "@/lib/agent-engine/pacing/saida-do-agente";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: async () => ({ data: null, error: null }) }) } }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";

const conversa = {
  id: CONV,
  organization_id: ORG,
  contact_id: CONTACT,
  channel_session_id: SESSION,
  is_group: false,
  group_chat_id: null,
  contacts: { phone_number: "+5588999990000", wa_identity: null, is_blocked: false },
  channel_sessions: { provider: "waha", waha_session_name: "default", status: "WORKING", archived_at: null },
};
const PROSPECCAO = [
  { organization_id: ORG, channel_session_id: SESSION, base_legal: "legitimate_interest", status: "completed", audience_filter: { sem_tags: ["sair"] } },
];
const KNOBS_8_18 = { window_start_hour: 8, window_end_hour: 18, allow_sunday: false, prospeccao_dias: [1, 2, 3, 4, 5], timezone: "America/Fortaleza" };

function banco(prospeccao = true, contato: Record<string, unknown> = {}) {
  return criarDubleDoHandler({
    conversation: conversa,
    campanhasDoNumero: prospeccao ? PROSPECCAO : [],
    knobsDoNumero: KNOBS_8_18,
    contatoDoNumero: { is_blocked: false, tags: [], force_human: false, ai_opt_out: false, consent: null, phone_number: null, ...contato },
  });
}
const texto: SendMessageInput = { conversation_id: CONV, type: "text", body: "Oi, passando para lembrar." } as SendMessageInput;
const ctxDe = (actor: HandlerCtx["actor"]): HandlerCtx => ({ organization_id: ORG, actor, requestId: "req-1" });
const AUTOMACAO = { type: "webhook_source", id: "inscricao-dormente" } as HandlerCtx["actor"];
const TOKEN = { type: "api_token", id: "token-1", role: "agent" } as unknown as HandlerCtx["actor"];
const AGENTE_EXTERNO = { type: "ai_agent", id: "run-1", role: "agent", api_token_id: "tok" } as HandlerCtx["actor"];
const MOTOR = { type: "ai_agent", id: "agent-engine", role: "agent" } as HandlerCtx["actor"];
const PESSOA = { type: "user", id: USER } as HandlerCtx["actor"];

function noInstante(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(iso));
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
async function recusa(p: Promise<unknown>): Promise<ApiError> {
  const e = await p.then(() => null, (erro: unknown) => erro);
  expect(e).toBeInstanceOf(ApiError);
  return e as ApiError;
}

describe("v20 · o número de prospecção no handler", () => {
  it.each([
    ["a automação (follow-up de texto fixo, inscrição dormente)", AUTOMACAO],
    ["a integração por token", TOKEN],
    ["o agente externo (MCP)", AGENTE_EXTERNO],
  ])("⭐ %s no feriado de 20/11/2026, às 10h: recusada, e nada sai nem é gravado", async (_nome, actor) => {
    noInstante("2026-11-20T13:00:00Z");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const d = banco();
    const e = await recusa(sendMessageHandler(d.supabase, ctxDe(actor), texto));
    expect(e.status).toBe(409);
    expect(e.details).toMatchObject({ motivo: "feriado_nacional" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(d.capturas.inserts.messages ?? []).toHaveLength(0);
  });

  it("⭐ a automação às 7h59 de quarta, com o número em 8–18: recusada (fora da janela)", async () => {
    noInstante("2026-11-18T10:59:00Z");
    const e = await recusa(sendMessageHandler(banco().supabase, ctxDe(AUTOMACAO), texto));
    expect(e.details).toMatchObject({ motivo: "fora_da_janela_de_prospeccao" });
  });

  it("⭐ a automação às 18h00 de quarta: recusada", async () => {
    noInstante("2026-11-18T21:00:00Z");
    const e = await recusa(sendMessageHandler(banco().supabase, ctxDe(AUTOMACAO), texto));
    expect(e.details).toMatchObject({ motivo: "fora_da_janela_de_prospeccao" });
  });

  it("controle: a mesma automação no feriado, num número que NÃO é de prospecção, segue como antes", async () => {
    noInstante("2026-11-20T13:00:00Z");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    const msg = await sendMessageHandler(banco(false).supabase, ctxDe(AUTOMACAO), texto);
    expect(msg.status).toBe("queued");
  });

  it("controle: a pessoa digitando no Inbox no feriado não é barrada (escolha humana)", async () => {
    noInstante("2026-11-20T13:00:00Z");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    const msg = await sendMessageHandler(banco().supabase, ctxDe(PESSOA), texto);
    expect(msg.status).toBe("queued");
  });

  it("controle: o motor do agente sem a saída no escopo (a cadeia já conferiu) não é barrado aqui", async () => {
    noInstante("2026-11-20T13:00:00Z");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    const msg = await sendMessageHandler(banco().supabase, ctxDe(MOTOR), texto);
    expect(msg.status).toBe("queued");
  });
});

describe("v20 · o envio do motor do agente no número de prospecção", () => {
  const comSaida = <T>(resposta: boolean, envio: () => Promise<T>) =>
    comSaidaDoAgente(
      novaSaidaDoAgente(new Date(), 10_000, () => new Date(), { resposta, haRespostaRetidaAntes: async () => false }),
      envio,
    );

  it("⭐ o disparo do motor (o retorno, o follow-up) para quem tem a etiqueta `sair`: recusado aqui de novo", async () => {
    noInstante("2026-11-18T13:00:00Z");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    const e = await recusa(comSaida(false, () => sendMessageHandler(banco(true, { tags: ["sair"] }).supabase, ctxDe(MOTOR), texto)));
    expect(e.status).toBe(403);
    expect(e.details).toMatchObject({ motivo: "etiqueta_de_parada" });
  });

  it("⭐ o disparo do motor no feriado não é recusado AQUI pela hora (a cadeia já a conferiu e adiou)", async () => {
    noInstante("2026-11-20T13:00:00Z");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    const msg = await comSaida(false, () => sendMessageHandler(banco().supabase, ctxDe(MOTOR), texto));
    expect(msg.status).toBe("queued");
  });

  it("⭐ a RESPOSTA do motor a quem tem a etiqueta `sair` (e escreveu de novo) não passa pela trava", async () => {
    noInstante("2026-11-18T13:00:00Z");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    const msg = await comSaida(true, () => sendMessageHandler(banco(true, { tags: ["sair"] }).supabase, ctxDe(MOTOR), texto));
    expect(msg.status).toBe("queued");
  });

  it("⭐ a automação para quem tem a etiqueta `tem-quem-cuide`, dentro da hora: recusada", async () => {
    noInstante("2026-11-18T13:00:00Z");
    const d = criarDubleDoHandler({
      conversation: conversa,
      campanhasDoNumero: [{ ...PROSPECCAO[0], audience_filter: { sem_tags: ["tem-quem-cuide"] } }],
      knobsDoNumero: KNOBS_8_18,
      contatoDoNumero: { is_blocked: false, tags: ["tem-quem-cuide"], force_human: false, ai_opt_out: false, consent: null, phone_number: null },
    });
    const e = await recusa(sendMessageHandler(d.supabase, ctxDe(AUTOMACAO), texto));
    expect(e.details).toMatchObject({ motivo: "etiqueta_de_parada" });
  });

  it("⭐ a automação com a conversa aberta com um atendente: recusada", async () => {
    noInstante("2026-11-18T13:00:00Z");
    const d = criarDubleDoHandler({
      conversation: conversa,
      campanhasDoNumero: PROSPECCAO,
      knobsDoNumero: KNOBS_8_18,
      contatoDoNumero: { is_blocked: false, tags: [], force_human: false, ai_opt_out: false, consent: null, phone_number: null },
      conversasDoContato: [{ status: "open", assigned_to_user_id: USER, bot_silenced_until: null }],
    });
    const e = await recusa(sendMessageHandler(d.supabase, ctxDe(AUTOMACAO), texto));
    expect(e.details).toMatchObject({ motivo: "atendimento_humano" });
  });

  it("controle: a automação dentro da hora, pessoa livre: sai", async () => {
    noInstante("2026-11-18T13:00:00Z");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    const msg = await sendMessageHandler(banco().supabase, ctxDe(AUTOMACAO), texto);
    expect(msg.status).toBe("queued");
  });

  it("⭐ o envio da própria campanha (consentimento, ator `campaign:`) no número de prospecção não passa pela trava", async () => {
    noInstante("2026-11-20T13:00:00Z");
    vi.stubEnv("WAHA_API_BASE_URL", "");
    const d = criarDubleDoHandler({
      conversation: conversa,
      campanhasDoNumero: [...PROSPECCAO, { id: "c-1", organization_id: ORG, base_legal: "consent", status: "running" }],
      knobsDoNumero: KNOBS_8_18,
    });
    const msg = await sendMessageHandler(d.supabase, ctxDe({ type: "webhook_source", id: "campaign:c-1" } as HandlerCtx["actor"]), texto);
    expect(msg.status).toBe("queued");
  });
});
