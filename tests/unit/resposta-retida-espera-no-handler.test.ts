/**
 * A RESPOSTA QUE ESPERA ATRÁS DA RETIDA, NO HANDLER (F4w do cxj, 12/11/2026, W02; versão 18).
 *
 * Na versão 17, a resposta do agente mais velha do que a folga no último passo do handler fica na fila (`queued`), e
 * quem a manda depois é o resgate do watchdog (ou a nova tentativa do job dela). O turno de resposta segue: a resposta
 * seguinte, com outro registro, saía na hora, e a retida chegava depois dela, fora de ordem.
 *
 * Agora a saída que o transporte carrega no escopo leva a ordem: se o envio responde a quem escreveu, e a pergunta
 * “há, nesta conversa, uma resposta do agente retida e mais antiga do que esta mensagem?”. O handler a faz em cada
 * corte, antes da conta da idade (a idade continua sendo a última conta antes do provedor). Havendo, a mensagem de
 * texto não sai: fica na fila, com o motivo `atras_de_resposta_retida`, e sai depois da mais antiga. A resposta retida
 * leva a marca `queued_resposta`: é ela que segura as seguintes.
 *
 * Aqui, a metade do handler, com a pergunta em memória sobre a tabela viva do dublê. A consulta de verdade
 * (`haRespostaRetidaAntes`), a cadeia e o resgate estão em `tests/invariants/resposta-retida-na-ordem.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import {
  ATRASO_MAXIMO_DA_SAIDA_DO_AGENTE_MS as FOLGA,
  MOTIVO_DA_SAIDA_ATRAS_DE_RETIDA,
  MOTIVO_DA_SAIDA_VENCIDA,
  MOTIVOS_DA_SAIDA_RETIDA,
  comSaidaDoAgente,
  novaSaidaDoAgente,
  saidaDoAgenteNoEscopo,
  tomarSaidaDoAgente,
  type OrdemDaSaidaDoAgente,
} from "@/lib/agent-engine/pacing/saida-do-agente";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import { criarDubleDoHandler, type LinhaDoDuble } from "@/tests/helpers/duble-do-handler";

vi.mock("@/lib/channels/endereco-da-ultima-recebida", () => ({
  enderecoDaUltimaRecebida: vi.fn(async () => null),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://storage.example/sign/foto.jpg" }, error: null }),
      }),
    },
  }),
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}) }));
vi.mock("@/lib/logger", () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }));

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const CHAVE_A = "55555555-5555-4555-8555-55555555555a";
const CHAVE_B = "55555555-5555-4555-8555-55555555555b";
const CHAVE_C = "55555555-5555-4555-8555-55555555555c";
const AGORA = new Date("2026-11-18T14:00:00Z");
const boundary = {
  organization_id: ORG,
  contact_id: CONTACT,
  conversation_id: CONV,
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

function montar() {
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
    chavePrimariaDaMensagem: true,
    rpcData: () => ({ ...boundary, status: "open", demanda_fechada_em: null }),
  });
  /** O que chegou ao provedor, na ordem: o texto, ou `[imagem]`. */
  const saidas: string[] = [];
  vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:3030");
  vi.stubEnv("WAHA_API_KEY", "ficticia");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).endsWith("/sendText")) saidas.push(String(JSON.parse(String(init?.body ?? "{}")).text));
      if (String(url).endsWith("/sendImage")) saidas.push("[imagem]");
      return Response.json({ id: { id: `FICTICIA-${saidas.length}` } });
    }),
  );
  return { ...duble, saidas };
}

/**
 * A pergunta da ordem, em memória, sobre a tabela viva do dublê: a mesma que `haRespostaRetidaAntes` faz ao banco. A
 * mais antiga é a que entrou antes na tabela.
 */
function ordemEmMemoria(mensagens: LinhaDoDuble[], resposta = true) {
  const perguntas: Array<{ conversationId: string; messageId: string }> = [];
  const ordem: OrdemDaSaidaDoAgente = {
    resposta,
    haRespostaRetidaAntes: async (mensagem) => {
      perguntas.push({ ...mensagem });
      const posicao = mensagens.findIndex((r) => r.id === mensagem.messageId);
      if (posicao < 0) throw new Error("mensagem_do_envio_nao_encontrada");
      return mensagens.slice(0, posicao).some((r) => {
        const metadata = (r.metadata ?? {}) as Record<string, unknown>;
        return (
          r.conversation_id === mensagem.conversationId &&
          r.direction === "outbound" &&
          r.type === "text" &&
          r.status === "queued" &&
          (MOTIVOS_DA_SAIDA_RETIDA as readonly string[]).includes(String(metadata.queued_reason)) &&
          metadata.queued_resposta === true
        );
      });
    },
  };
  return { ordem, perguntas };
}

/** A saída dentro da folga, e a que já passou dela no último passo. */
const dentro = (ordem: OrdemDaSaidaDoAgente | null) => novaSaidaDoAgente(AGORA, FOLGA, () => AGORA, ordem);
const vencida = (ordem: OrdemDaSaidaDoAgente | null) =>
  novaSaidaDoAgente(AGORA, FOLGA, () => new Date(+AGORA + FOLGA + 1), ordem);

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "ai_agent", id: "agente-ficticio", role: "manager" },
  requestId: "pedido-ficticio",
  serviceBoundary: boundary,
};
const com = (chave: string): HandlerCtx => ({ ...ctx, internalMessageId: chave });
const texto = (body = "Resposta fictícia") => ({ conversation_id: CONV, type: "text", body }) as SendMessageInput;
const metadataDe = (linha: LinhaDoDuble | undefined) => (linha?.metadata ?? {}) as Record<string, unknown>;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("a ordem no escopo da saída do agente (versão 18)", () => {
  it("os dois motivos da mensagem retida pela cadeia do agente: por idade e por ordem", () => {
    expect(MOTIVO_DA_SAIDA_VENCIDA).toBe("saida_do_agente_vencida");
    expect(MOTIVO_DA_SAIDA_ATRAS_DE_RETIDA).toBe("atras_de_resposta_retida");
    expect([...MOTIVOS_DA_SAIDA_RETIDA]).toEqual(["saida_do_agente_vencida", "atras_de_resposta_retida"]);
  });

  it("a saída do escopo é lida sem ser tomada: a 2ª mensagem física do envio também a acha", async () => {
    expect(saidaDoAgenteNoEscopo()).toBeNull();
    const { ordem } = ordemEmMemoria([]);
    const saida = dentro(ordem);
    await comSaidaDoAgente(saida, async () => {
      await Promise.resolve();
      expect(saidaDoAgenteNoEscopo()).toBe(saida);
      expect(tomarSaidaDoAgente()).toBe(saida);
      // Tomada pela 1ª mensagem física, a saída segue no escopo para a ordem.
      expect(tomarSaidaDoAgente()).toBeNull();
      expect(saidaDoAgenteNoEscopo()).toBe(saida);
      expect(saidaDoAgenteNoEscopo()?.ordem).toBe(ordem);
    });
    expect(saidaDoAgenteNoEscopo()).toBeNull();
  });

  it("sem a ordem, a saída nasce como na versão 17", () => {
    expect(novaSaidaDoAgente(AGORA, FOLGA, () => AGORA).ordem).toBeNull();
  });
});

describe("sendMessageHandler × a resposta retida (F4w, W02)", () => {
  it("⭐ W02 do cxj, adaptado: a resposta posterior não ultrapassa a retida por idade, e as duas saem na ordem", async () => {
    const { supabase, saidas, mensagens } = montar();
    const { ordem } = ordemEmMemoria(mensagens);
    // A 1ª resposta vence no último passo: fica na fila, com o motivo e a marca de resposta.
    const primeira = await comSaidaDoAgente(vencida(ordem), () =>
      sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")),
    );
    expect(primeira).toMatchObject({ status: "queued" });
    expect(metadataDe(mensagens[0])).toMatchObject({ queued_reason: "saida_do_agente_vencida", queued_resposta: true });
    // A 2ª, com a saída dentro da folga, não chega ao provedor: espera atrás da 1ª.
    const segunda = await comSaidaDoAgente(dentro(ordem), () =>
      sendMessageHandler(supabase, com(CHAVE_B), texto("Segunda")),
    );
    expect(saidas).toEqual([]);
    expect(segunda).toMatchObject({ status: "queued" });
    expect(metadataDe(mensagens[1])).toMatchObject({ queued_reason: "atras_de_resposta_retida", queued_resposta: true });
    // A retomada pelo mesmo id (a nova tentativa do job): a 1ª sai, e só então a 2ª.
    await comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")));
    expect(saidas).toEqual(["Primeira"]);
    await comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_B), texto("Segunda")));
    expect(saidas).toEqual(["Primeira", "Segunda"]);
    expect(mensagens.map((m) => m.status)).toEqual(["sent", "sent"]);
  });

  it("a que esperou por ordem também segura a seguinte, e na retomada ninguém passa na frente", async () => {
    const { supabase, saidas, mensagens } = montar();
    const { ordem } = ordemEmMemoria(mensagens);
    const enviar = (chave: string, body: string, saida = dentro(ordem)) =>
      comSaidaDoAgente(saida, () => sendMessageHandler(supabase, com(chave), texto(body)));
    await enviar(CHAVE_A, "A", vencida(ordem));
    await enviar(CHAVE_B, "B");
    await enviar(CHAVE_C, "C");
    expect(saidas).toEqual([]);
    expect(mensagens.map((m) => metadataDe(m).queued_reason)).toEqual([
      "saida_do_agente_vencida",
      "atras_de_resposta_retida",
      "atras_de_resposta_retida",
    ]);
    // Fora de ordem, a retomada não passa: a C espera a B, e a B espera a A.
    await enviar(CHAVE_C, "C");
    await enviar(CHAVE_B, "B");
    expect(saidas).toEqual([]);
    await enviar(CHAVE_A, "A");
    await enviar(CHAVE_C, "C");
    expect(saidas).toEqual(["A"]);
    await enviar(CHAVE_B, "B");
    await enviar(CHAVE_C, "C");
    expect(saidas).toEqual(["A", "B", "C"]);
  });

  it("a retida por idade que não é resposta não leva a marca, e não segura a resposta seguinte", async () => {
    const { supabase, saidas, mensagens } = montar();
    const naoResposta = ordemEmMemoria(mensagens, false).ordem;
    const resposta = ordemEmMemoria(mensagens).ordem;
    await comSaidaDoAgente(vencida(naoResposta), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Retorno")));
    expect(mensagens[0]).toMatchObject({ status: "queued" });
    expect(metadataDe(mensagens[0])).toEqual(expect.objectContaining({ queued_reason: "saida_do_agente_vencida" }));
    expect(metadataDe(mensagens[0])).not.toHaveProperty("queued_resposta");
    await comSaidaDoAgente(dentro(resposta), () => sendMessageHandler(supabase, com(CHAVE_B), texto("Resposta")));
    expect(saidas).toEqual(["Resposta"]);
  });

  it("o envio que não é resposta também espera atrás da resposta retida, sem levar a marca", async () => {
    const { supabase, saidas, mensagens } = montar();
    const resposta = ordemEmMemoria(mensagens).ordem;
    const naoResposta = ordemEmMemoria(mensagens, false).ordem;
    await comSaidaDoAgente(vencida(resposta), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Resposta")));
    await comSaidaDoAgente(dentro(naoResposta), () => sendMessageHandler(supabase, com(CHAVE_B), texto("Retorno")));
    expect(saidas).toEqual([]);
    expect(mensagens[1]).toMatchObject({ status: "queued" });
    expect(metadataDe(mensagens[1])).toEqual(expect.objectContaining({ queued_reason: "atras_de_resposta_retida" }));
    expect(metadataDe(mensagens[1])).not.toHaveProperty("queued_resposta");
  });

  it("controle: sem resposta retida, o envio sai, e a pergunta foi feita em cada corte, com a conversa e a mensagem", async () => {
    const { supabase, saidas, mensagens } = montar();
    const { ordem, perguntas } = ordemEmMemoria(mensagens);
    await comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_A), texto()));
    expect(saidas).toEqual(["Resposta fictícia"]);
    // O 1º corte e o do último passo, como a idade.
    expect(perguntas).toEqual([
      { conversationId: CONV, messageId: CHAVE_A },
      { conversationId: CONV, messageId: CHAVE_A },
    ]);
  });

  it("em cada corte, a pergunta vem antes da idade: a idade continua sendo a última conta antes do provedor", async () => {
    const { supabase, saidas, mensagens } = montar();
    const passos: string[] = [];
    const { ordem } = ordemEmMemoria(mensagens);
    const comRastro: OrdemDaSaidaDoAgente = {
      resposta: true,
      haRespostaRetidaAntes: async (mensagem) => {
        passos.push("ordem");
        return ordem.haRespostaRetidaAntes(mensagem);
      },
    };
    const saida = novaSaidaDoAgente(
      AGORA,
      FOLGA,
      () => {
        passos.push("idade");
        return AGORA;
      },
      comRastro,
    );
    await comSaidaDoAgente(saida, () => sendMessageHandler(supabase, com(CHAVE_A), texto()));
    expect(saidas).toEqual(["Resposta fictícia"]);
    expect(passos).toEqual(["ordem", "idade", "ordem", "idade"]);
  });

  it("⭐ a espera da pergunta entra na idade: a saída que vence durante ela não sai", async () => {
    const { supabase, saidas, mensagens } = montar();
    let relogio = +AGORA, perguntas = 0;
    const lenta: OrdemDaSaidaDoAgente = {
      resposta: true,
      haRespostaRetidaAntes: async () => {
        // A leitura do último passo demora: o relógio passa da folga antes de ela voltar.
        if (++perguntas === 2) relogio = +AGORA + FOLGA + 1;
        return false;
      },
    };
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => new Date(relogio), lenta);
    await comSaidaDoAgente(saida, () => sendMessageHandler(supabase, com(CHAVE_A), texto()));
    expect(perguntas).toBe(2);
    expect(saidas).toEqual([]);
    expect(mensagens[0]).toMatchObject({ status: "queued" });
    expect(metadataDe(mensagens[0])).toMatchObject({ queued_reason: "saida_do_agente_vencida", queued_resposta: true });
  });

  it("as bolhas (W10 do cxj, adaptado): a 2ª mensagem física do mesmo envio espera atrás da 1ª, retida por idade", async () => {
    const { supabase, saidas, mensagens } = montar();
    const { ordem } = ordemEmMemoria(mensagens);
    await comSaidaDoAgente(vencida(ordem), async () => {
      await sendMessageHandler(supabase, com(CHAVE_A), texto("Bolha 1"));
      // A 2ª não toma a saída (a idade é só da 1ª), mas lê a ordem do mesmo escopo.
      await sendMessageHandler(supabase, com(CHAVE_B), texto("Bolha 2"));
    });
    expect(saidas).toEqual([]);
    expect(mensagens.map((m) => [m.status, metadataDe(m).queued_reason])).toEqual([
      ["queued", "saida_do_agente_vencida"],
      ["queued", "atras_de_resposta_retida"],
    ]);
  });

  it("a mídia fica fora da regra: a imagem não pergunta e sai (o resgate só manda texto)", async () => {
    const { supabase, saidas, mensagens } = montar();
    const { ordem, perguntas } = ordemEmMemoria(mensagens);
    await comSaidaDoAgente(vencida(ordem), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")));
    perguntas.length = 0;
    const imagem = {
      conversation_id: CONV,
      type: "image",
      media_storage_path: `${ORG}/${CONV}/foto.jpg`,
      media_mime: "image/jpeg",
    } as SendMessageInput;
    await comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_B), imagem));
    expect(perguntas).toEqual([]);
    expect(saidas).toEqual(["[imagem]"]);
  });

  it("a pergunta que falha não deixa sair: a mensagem vira falha, e nada chega ao provedor", async () => {
    const { supabase, saidas, mensagens } = montar();
    const quebrada: OrdemDaSaidaDoAgente = {
      resposta: true,
      haRespostaRetidaAntes: async () => {
        throw new Error("leitura indisponível");
      },
    };
    await comSaidaDoAgente(dentro(quebrada), () => sendMessageHandler(supabase, com(CHAVE_A), texto()));
    expect(saidas).toEqual([]);
    expect(mensagens[0]).toMatchObject({ status: "failed" });
  });

  it("controle do limite declarado: fora do escopo do agente, o envio manual sai, mesmo com uma resposta retida", async () => {
    const { supabase, saidas, mensagens } = montar();
    const { ordem } = ordemEmMemoria(mensagens);
    await comSaidaDoAgente(vencida(ordem), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")));
    await sendMessageHandler(supabase, { ...ctx, actor: { type: "user", id: "atendente-ficticia" } }, texto("Manual"));
    expect(saidas).toEqual(["Manual"]);
  });

  it("controle: a saída sem a ordem (versão 17) não pergunta nada, e a resposta seguinte sai", async () => {
    const { supabase, saidas } = montar();
    await comSaidaDoAgente(vencida(null), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")));
    await comSaidaDoAgente(dentro(null), () => sendMessageHandler(supabase, com(CHAVE_B), texto("Segunda")));
    expect(saidas).toEqual(["Segunda"]);
  });
});
