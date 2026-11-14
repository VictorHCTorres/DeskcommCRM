/**
 * A SAÍDA DO AGENTE CONFERIDA NO ÚLTIMO PASSO DO HANDLER (F4v do cxj, 12/11/2026, V01; versão 17).
 *
 * A cadeia do agente (`runBeforeSend`) grava o registro da saída sob a trava do número, e o transporte vem depois: o
 * handler ainda grava a mensagem e confere a fronteira antes de chamar o provedor. A hora do registro ficava para trás,
 * e o resgate e a campanha mediam o intervalo dela. Agora o transporte roda com a saída no escopo
 * (`comSaidaDoAgente`), e o handler confere a idade dela no último passo, depois de todas as esperas, como já confere a
 * vaga da campanha: a saída mais velha do que a folga não chega ao provedor, e a mensagem fica na fila (`queued`), com
 * o motivo, para a nova tentativa do job ou o resgate, cada um com a própria vaga.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import {
  ATRASO_MAXIMO_DA_SAIDA_DO_AGENTE_MS as FOLGA,
  SaidaDoAgenteVencidaError,
  comSaidaDoAgente,
  conferirSaidaDoAgente,
  novaSaidaDoAgente,
  tomarSaidaDoAgente,
} from "@/lib/agent-engine/pacing/saida-do-agente";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ATRASO_MAXIMO_DA_VAGA_DA_CAMPANHA_MS } from "@/lib/campanhas/rodada";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/channels/endereco-da-ultima-recebida", () => ({
  enderecoDaUltimaRecebida: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ storage: { from: () => ({}) } }) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const AGORA = new Date("2026-11-18T14:00:00Z");
const boundary = {
  organization_id: ORG,
  contact_id: CONTACT,
  conversation_id: CONV,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

/** `aoLerAFronteira` roda a cada leitura da fronteira do atendimento (`fn_service_boundary`): no começo e em cada corte. */
function montar(aoLerAFronteira?: () => void) {
  const conversation = {
    ...boundary,
    id: CONV,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    contacts: { phone_number: "+5588999990000", wa_identity: null, wa_lid: null, is_blocked: false, is_personal: false },
    channel_sessions: { provider: "waha", waha_session_name: "ficticia", status: "WORKING" },
  };
  const duble = criarDubleDoHandler({
    conversation,
    rpcData: () => {
      if (duble.capturas.rpcs.at(-1)?.nome === "fn_service_boundary") aoLerAFronteira?.();
      return { ...boundary, status: "open", demanda_fechada_em: null };
    },
  });
  const saidas: string[] = [];
  vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:3030");
  vi.stubEnv("WAHA_API_KEY", "ficticia");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).endsWith("/sendText")) saidas.push(String(JSON.parse(String(init?.body ?? "{}")).text));
      return Response.json({ id: { id: "FICTICIA" } });
    }),
  );
  return { ...duble, saidas };
}
const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "ai_agent", id: "agente-ficticio", role: "manager" },
  requestId: "pedido-ficticio",
  serviceBoundary: boundary,
};
const texto = (body = "Resposta fictícia") => ({ conversation_id: CONV, type: "text", body }) as SendMessageInput;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a saída do agente no escopo do transporte", () => {
  it("a folga da saída do agente é a da vaga da campanha, 10 s: o caminho até o provedor é o mesmo handler", () => {
    expect(FOLGA).toBe(10_000);
    expect(FOLGA).toBe(ATRASO_MAXIMO_DA_VAGA_DA_CAMPANHA_MS);
  });

  it("fora do escopo não há saída; dentro, a 1ª mensagem física a toma, e a 2ª não", async () => {
    expect(tomarSaidaDoAgente()).toBeNull();
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => AGORA);
    await comSaidaDoAgente(saida, async () => {
      // O escopo atravessa as esperas do transporte.
      await Promise.resolve();
      expect(tomarSaidaDoAgente()).toBe(saida);
      expect(tomarSaidaDoAgente()).toBeNull();
    });
    expect(tomarSaidaDoAgente()).toBeNull();
  });

  it("a conferência passa até a folga, inclusive, e lança quando a idade passa dela", () => {
    let relogio = +AGORA + FOLGA;
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => new Date(relogio));
    expect(() => conferirSaidaDoAgente(saida)).not.toThrow();
    relogio += 1;
    const erro = (() => {
      try {
        conferirSaidaDoAgente(saida);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(erro).toBeInstanceOf(SaidaDoAgenteVencidaError);
    expect((erro as SaidaDoAgenteVencidaError).idadeMs).toBe(FOLGA + 1);
  });
});

describe("sendMessageHandler × a saída do agente (F4v, V01)", () => {
  it("dentro da folga, a resposta sai, e a idade é conferida duas vezes: no 1º corte e no último passo", async () => {
    const { supabase, saidas, mensagens } = montar();
    // O relógio anda 1 s a cada leitura: a 1ª conferência lê 1 s, e a do último passo, 2 s.
    let leituras = 0;
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => new Date(+AGORA + ++leituras * 1000));
    await comSaidaDoAgente(saida, () => sendMessageHandler(supabase, ctx, texto()));
    expect(saidas).toEqual(["Resposta fictícia"]);
    expect(mensagens[0]).toMatchObject({ status: "sent" });
    expect(leituras).toBe(2);
  });

  it("⭐ mais velha do que a folga, a resposta não chega ao provedor, e a mensagem fica na fila com o motivo", async () => {
    const { supabase, saidas, mensagens } = montar();
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => new Date(+AGORA + FOLGA + 1));
    const devolvida = await comSaidaDoAgente(saida, () => sendMessageHandler(supabase, ctx, texto()));
    expect(saidas).toEqual([]);
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({ status: "queued", metadata: { queued_reason: "saida_do_agente_vencida" } });
    expect(devolvida).toMatchObject({ status: "queued" });
  });

  it("⭐ a idade vale no último passo: a saída que vence entre a 1ª conferência e o provedor não sai", async () => {
    const { supabase, saidas, mensagens } = montar();
    // A 1ª conferência lê o relógio dentro da folga; a do último passo, depois das esperas, já fora dela.
    let leituras = 0;
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => new Date(+AGORA + (++leituras === 1 ? 0 : FOLGA + 1)));
    await comSaidaDoAgente(saida, () => sendMessageHandler(supabase, ctx, texto()));
    expect(leituras).toBe(2);
    expect(saidas).toEqual([]);
    expect(mensagens[0]).toMatchObject({ status: "queued", metadata: { queued_reason: "saida_do_agente_vencida" } });
  });

  it("só a 1ª mensagem física do envio é conferida: a 2ª, no mesmo escopo, sai sem a idade", async () => {
    const { supabase, saidas } = montar();
    let relogio = +AGORA;
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => new Date(relogio));
    await comSaidaDoAgente(saida, async () => {
      await sendMessageHandler(supabase, { ...ctx, requestId: "bolha-1" }, texto("Bolha 1"));
      relogio += FOLGA + 1;
      await sendMessageHandler(supabase, { ...ctx, requestId: "bolha-2" }, texto("Bolha 2"));
    });
    expect(saidas).toEqual(["Bolha 1", "Bolha 2"]);
  });

  it("controle: fora do escopo do agente, o envio sai como sempre", async () => {
    const { supabase, saidas } = montar();
    await sendMessageHandler(supabase, ctx, texto());
    expect(saidas).toEqual(["Resposta fictícia"]);
  });
});

describe("sendMessageHandler × a saída do agente: a conta é a última do corte", () => {
  it("⭐ a espera das outras conferências entra na idade: a saída que vence durante elas não sai", async () => {
    // Calibração: num envio que sai, a última leitura da fronteira é a do corte do último passo, logo antes do provedor.
    let total = 0;
    const calibre = montar(() => {
      total += 1;
    });
    await sendMessageHandler(calibre.supabase, ctx, texto());
    expect(calibre.saidas).toHaveLength(1);
    // O começo do handler, o 1º corte e o corte do último passo.
    expect(total).toBe(3);

    // Com a saída no escopo, o relógio passa da folga nessa última leitura. Conferida antes dela, no mesmo corte, a
    // idade ainda estaria dentro da folga, e a mensagem sairia.
    let relogio = +AGORA, leituras = 0, conferencias = 0;
    const { supabase, saidas, mensagens } = montar(() => {
      leituras += 1;
      if (leituras === total) relogio = +AGORA + FOLGA + 1;
    });
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => {
      conferencias += 1;
      return new Date(relogio);
    });
    await comSaidaDoAgente(saida, () => sendMessageHandler(supabase, ctx, texto()));
    expect(leituras).toBe(total);
    expect(conferencias).toBe(2);
    expect(saidas).toEqual([]);
    expect(mensagens[0]).toMatchObject({ status: "queued", metadata: { queued_reason: "saida_do_agente_vencida" } });
  });
});
