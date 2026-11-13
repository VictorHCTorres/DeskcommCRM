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
 * A MARCA NASCE COM A MENSAGEM (versão 19, F4x do cxj, 12/11/2026, X01 e X08). Na versão 18, a marca de resposta era
 * gravada só na retenção, junto com o motivo, e o erro dessa gravação era ignorado: se ela falhasse, a linha ficava na
 * fila sem a marca, fora da ordem, e a resposta seguinte passava na frente (X01). E a ordem pedia um dos dois motivos da
 * cadeia: a nova tentativa com o canal fora do ar trocava o motivo, e a retida deixava de segurar a seguinte (X08).
 * Agora a resposta de texto do agente é gravada já com a marca, e a pergunta da ordem conta a resposta que ainda está
 * na fila, com qualquer motivo, ou sem nenhum. O motivo segue sendo gravado na retenção, com uma 2ª tentativa e o erro
 * no log; ele informa a tela, e não decide mais a ordem.
 *
 * Aqui, a metade do handler, com a pergunta em memória sobre a tabela viva do dublê. A consulta de verdade
 * (`haRespostaRetidaAntes`), a cadeia e o resgate estão em `tests/invariants/resposta-retida-na-ordem.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import {
  ATRASO_MAXIMO_DA_SAIDA_DO_AGENTE_MS as FOLGA,
  MARCA_DE_RESPOSTA_RETIDA,
  MOTIVO_DA_SAIDA_ATRAS_DE_RETIDA,
  MOTIVO_DA_SAIDA_VENCIDA,
  comSaidaDoAgente,
  novaSaidaDoAgente,
  saidaDoAgenteNoEscopo,
  tomarSaidaDoAgente,
  type OrdemDaSaidaDoAgente,
} from "@/lib/agent-engine/pacing/saida-do-agente";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type { SendMessageInput } from "@/lib/schemas";
import {
  criarDubleDoHandler,
  type LinhaDoDuble,
  type OpcoesDoDubleDoHandler,
} from "@/tests/helpers/duble-do-handler";

/** O log de erro do handler: o que a gravação da retenção que falha deixa para quem opera. */
const registro = vi.hoisted(() => ({ error: vi.fn() }));

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
vi.mock("@/lib/logger", () => ({ logger: { info: () => {}, warn: () => {}, error: registro.error } }));

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

interface OpcoesDaMontagem {
  /** O estado da sessão do canal; fora de `WORKING`, o handler deixa a mensagem na fila antes de qualquer corte. */
  sessao?: string;
  mensagensIniciais?: LinhaDoDuble[];
  erroAoAtualizarMensagem?: OpcoesDoDubleDoHandler["erroAoAtualizarMensagem"];
}
function montar(opcoes: OpcoesDaMontagem = {}) {
  const conversation = {
    ...boundary,
    id: CONV,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    bot_silenced_until: null,
    contacts: { phone_number: "+5588999990000", wa_identity: null, wa_lid: null, is_blocked: false, is_personal: false },
    channel_sessions: { provider: "waha", waha_session_name: "ficticia", status: opcoes.sessao ?? "WORKING" },
  };
  const duble = criarDubleDoHandler({
    conversation,
    chavePrimariaDaMensagem: true,
    rpcData: () => ({ ...boundary, status: "open", demanda_fechada_em: null }),
    mensagensIniciais: opcoes.mensagensIniciais,
    erroAoAtualizarMensagem: opcoes.erroAoAtualizarMensagem,
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
 * mais antiga é a que entrou antes na tabela. Na versão 19, conta a resposta que ainda está na fila, com a marca, seja
 * qual for o motivo.
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
  registro.error.mockClear();
});

describe("a ordem no escopo da saída do agente (versão 18)", () => {
  it("os dois motivos da mensagem retida pela cadeia do agente: por idade e por ordem", () => {
    expect(MOTIVO_DA_SAIDA_VENCIDA).toBe("saida_do_agente_vencida");
    expect(MOTIVO_DA_SAIDA_ATRAS_DE_RETIDA).toBe("atras_de_resposta_retida");
  });

  it("a marca de resposta, em `messages.metadata`: o nome que a pergunta da ordem lê no banco", () => {
    expect(MARCA_DE_RESPOSTA_RETIDA).toBe("queued_resposta");
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

describe("sendMessageHandler × a marca que nasce com a mensagem (versão 19, F4x do cxj, X01 e X08)", () => {
  const manual: HandlerCtx = { ...ctx, actor: { type: "user", id: "atendente-ficticia" } };
  const imagem = {
    conversation_id: CONV,
    type: "image",
    media_storage_path: `${ORG}/${CONV}/foto.jpg`,
    media_mime: "image/jpeg",
  } as SendMessageInput;
  /** A recusa do banco, fictícia. */
  const RECUSA = { code: "57014", message: "gravação recusada (fictícia)" };
  /** A mensagem do agente que já estava na fila sem a marca: a que nasceu antes desta versão. */
  const SEM_A_MARCA: LinhaDoDuble = {
    id: CHAVE_A,
    organization_id: ORG,
    conversation_id: CONV,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    direction: "outbound",
    type: "text",
    status: "queued",
    body: "Primeira",
    sent_via: "ai",
    metadata: { ai_actor_id: "agente-ficticio" },
  };

  it("⭐ a resposta de texto do agente nasce com a marca: a linha é gravada com ela, antes de qualquer corte", async () => {
    const { supabase, saidas, mensagens, capturas } = montar();
    const { ordem } = ordemEmMemoria(mensagens);
    await comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")));
    expect(capturas.inserts.messages).toHaveLength(1);
    expect(metadataDe(capturas.inserts.messages![0])).toMatchObject({ queued_resposta: true });
    // Enviada, ela não segura ninguém: a pergunta só conta a que ainda está na fila.
    expect(saidas).toEqual(["Primeira"]);
    expect(mensagens[0]).toMatchObject({ status: "sent" });
    await comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_B), texto("Segunda")));
    expect(saidas).toEqual(["Primeira", "Segunda"]);
  });

  it("controle: não nasce com a marca o envio do agente que não é resposta, nem a mídia, nem a saída sem a ordem, nem o envio manual", async () => {
    const { supabase, mensagens, capturas } = montar();
    const resposta = ordemEmMemoria(mensagens).ordem;
    const naoResposta = ordemEmMemoria(mensagens, false).ordem;
    await comSaidaDoAgente(dentro(naoResposta), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Retorno")));
    await comSaidaDoAgente(dentro(resposta), () => sendMessageHandler(supabase, com(CHAVE_B), imagem));
    await comSaidaDoAgente(dentro(null), () => sendMessageHandler(supabase, com(CHAVE_C), texto("Sem a ordem")));
    await sendMessageHandler(supabase, manual, texto("Manual"));
    expect(capturas.inserts.messages).toHaveLength(4);
    for (const linha of capturas.inserts.messages!) expect(metadataDe(linha)).not.toHaveProperty("queued_resposta");
  });

  it("a marca é do handler: a que vem no metadata de quem chama não é gravada, e o resto do metadata fica", async () => {
    const { supabase, mensagens, capturas } = montar();
    const forjada = (body: string) =>
      ({ ...texto(body), metadata: { queued_resposta: true, origem: "integração" } }) as SendMessageInput;
    await sendMessageHandler(supabase, manual, forjada("Manual"));
    const naoResposta = ordemEmMemoria(mensagens, false).ordem;
    await comSaidaDoAgente(dentro(naoResposta), () => sendMessageHandler(supabase, com(CHAVE_A), forjada("Retorno")));
    expect(capturas.inserts.messages).toHaveLength(2);
    for (const linha of capturas.inserts.messages!) {
      expect(metadataDe(linha)).not.toHaveProperty("queued_resposta");
      expect(metadataDe(linha)).toMatchObject({ origem: "integração" });
    }
  });

  it("⭐ X01 do cxj: a gravação do motivo que falha não tira a resposta da ordem, e o erro fica no log", async () => {
    const recusadas: LinhaDoDuble[] = [];
    const { supabase, saidas, mensagens } = montar({
      erroAoAtualizarMensagem: (patch) => {
        if (metadataDe(patch).queued_reason !== "saida_do_agente_vencida") return null;
        recusadas.push(patch);
        return RECUSA;
      },
    });
    const { ordem } = ordemEmMemoria(mensagens);
    const primeira = await comSaidaDoAgente(vencida(ordem), () =>
      sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")),
    );
    // Nada saiu, e a linha segue na fila: sem o motivo, que não gravou, e com a marca, que nasceu com ela.
    expect(saidas).toEqual([]);
    expect(primeira).toMatchObject({ status: "queued" });
    expect(metadataDe(mensagens[0])).toMatchObject({ queued_resposta: true });
    expect(metadataDe(mensagens[0])).not.toHaveProperty("queued_reason");
    // A resposta seguinte espera atrás dela.
    await comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_B), texto("Segunda")));
    expect(saidas).toEqual([]);
    expect(metadataDe(mensagens[1])).toMatchObject({ queued_reason: "atras_de_resposta_retida", queued_resposta: true });
    // Duas tentativas de gravar o motivo, e o erro no log, com a mensagem e o motivo que não gravou.
    expect(recusadas).toHaveLength(2);
    expect(registro.error).toHaveBeenCalledTimes(1);
    expect(registro.error).toHaveBeenCalledWith("messages.send.retencao_sem_motivo", {
      message_id: CHAVE_A,
      organization_id: ORG,
      motivo: "saida_do_agente_vencida",
      erro: RECUSA.message,
    });
  });

  it("a gravação do motivo que falha uma vez é tentada de novo: o motivo fica gravado, e nada vai para o log", async () => {
    let tentativas = 0;
    const { supabase, mensagens } = montar({
      erroAoAtualizarMensagem: (patch) =>
        metadataDe(patch).queued_reason === "saida_do_agente_vencida" && tentativas++ === 0 ? RECUSA : null,
    });
    const { ordem } = ordemEmMemoria(mensagens);
    const primeira = await comSaidaDoAgente(vencida(ordem), () =>
      sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")),
    );
    expect(tentativas).toBe(2);
    expect(metadataDe(primeira as unknown as LinhaDoDuble)).toMatchObject({
      queued_reason: "saida_do_agente_vencida",
      queued_resposta: true,
    });
    expect(metadataDe(mensagens[0])).toMatchObject({ queued_reason: "saida_do_agente_vencida", queued_resposta: true });
    expect(registro.error).not.toHaveBeenCalled();
  });

  it("⭐ a mensagem que nasceu sem a marca (antes desta versão) a ganha na nova tentativa do job, antes de qualquer saída", async () => {
    const { supabase, saidas, mensagens } = montar({ sessao: "STOPPED", mensagensIniciais: [SEM_A_MARCA] });
    const { ordem } = ordemEmMemoria(mensagens);
    const retomada = await comSaidaDoAgente(dentro(ordem), () =>
      sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")),
    );
    // O canal está fora do ar: a linha segue na fila, com o motivo dele, e já com a marca.
    expect(saidas).toEqual([]);
    expect(retomada).toMatchObject({ status: "queued" });
    expect(mensagens).toHaveLength(1);
    expect(metadataDe(mensagens[0])).toEqual({
      ai_actor_id: "agente-ficticio",
      queued_resposta: true,
      queued_reason: "channel_session_not_working",
    });
  });

  it("se a marca não grava na nova tentativa, nada sai e o erro sobe: a linha segue na fila, sem virar falha", async () => {
    const { supabase, saidas, mensagens } = montar({
      mensagensIniciais: [SEM_A_MARCA],
      erroAoAtualizarMensagem: (patch) => (metadataDe(patch).queued_resposta === true ? RECUSA : null),
    });
    const { ordem } = ordemEmMemoria(mensagens);
    await expect(
      comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira"))),
    ).rejects.toThrow("marca_de_resposta_nao_gravada");
    expect(saidas).toEqual([]);
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).toMatchObject({ status: "queued", metadata: { ai_actor_id: "agente-ficticio" } });
    expect(metadataDe(mensagens[0])).not.toHaveProperty("queued_resposta");
  });

  it("a marca que falha uma vez na nova tentativa é gravada na 2ª, e o envio segue", async () => {
    let tentativas = 0;
    const { supabase, saidas, mensagens } = montar({
      mensagensIniciais: [SEM_A_MARCA],
      erroAoAtualizarMensagem: (patch) =>
        !("status" in patch) && metadataDe(patch).queued_resposta === true && tentativas++ === 0 ? RECUSA : null,
    });
    const { ordem } = ordemEmMemoria(mensagens);
    await comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(supabase, com(CHAVE_A), texto("Primeira")));
    expect(tentativas).toBe(2);
    expect(saidas).toEqual(["Primeira"]);
    expect(mensagens[0]).toMatchObject({ status: "sent" });
    expect(metadataDe(mensagens[0])).toMatchObject({ queued_resposta: true });
  });

  it("a linha que some entre a leitura e a gravação da marca: nada sai, e o erro sobe", async () => {
    let tabela: LinhaDoDuble[] = [];
    const montagem = montar({
      mensagensIniciais: [SEM_A_MARCA],
      erroAoAtualizarMensagem: (patch) => {
        // Outro processo apagou a linha: a gravação da marca não acha ninguém, sem erro do banco.
        if (metadataDe(patch).queued_resposta === true) tabela.length = 0;
        return null;
      },
    });
    tabela = montagem.mensagens;
    const { ordem } = ordemEmMemoria(montagem.mensagens);
    await expect(
      comSaidaDoAgente(dentro(ordem), () => sendMessageHandler(montagem.supabase, com(CHAVE_A), texto("Primeira"))),
    ).rejects.toThrow("marca_de_resposta_nao_gravada");
    expect(montagem.saidas).toEqual([]);
  });

  it("controle: na nova tentativa, a mensagem que já tem a marca não é regravada, e a que não é resposta segue sem ela", async () => {
    const comAMarca = { ...SEM_A_MARCA, metadata: { ai_actor_id: "agente-ficticio", queued_resposta: true } };
    const a = montar({ sessao: "STOPPED", mensagensIniciais: [comAMarca] });
    await comSaidaDoAgente(dentro(ordemEmMemoria(a.mensagens).ordem), () =>
      sendMessageHandler(a.supabase, com(CHAVE_A), texto("Primeira")),
    );
    // Uma gravação só: a do canal fora do ar.
    expect(a.capturas.patches.messages).toHaveLength(1);
    expect(metadataDe(a.mensagens[0])).toMatchObject({ queued_resposta: true, queued_reason: "channel_session_not_working" });
    const b = montar({ sessao: "STOPPED", mensagensIniciais: [SEM_A_MARCA] });
    await comSaidaDoAgente(dentro(ordemEmMemoria(b.mensagens, false).ordem), () =>
      sendMessageHandler(b.supabase, com(CHAVE_A), texto("Retorno")),
    );
    expect(b.capturas.patches.messages).toHaveLength(1);
    expect(metadataDe(b.mensagens[0])).not.toHaveProperty("queued_resposta");
  });
});
