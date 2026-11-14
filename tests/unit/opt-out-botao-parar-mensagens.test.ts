import { describe, expect, it } from "vitest";

import { detectAmbiguousOptOut } from "@/lib/agent-engine/agent/human-handoff";
import { parseMetaWebhook, type InboundMessageEvent } from "@/lib/channels/meta/webhook";
import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";

/**
 * O botão "Parar mensagens" do modelo oficial da Linha A (1.110.2).
 *
 * A Meta aprovou o botão como resposta rápida comum, não como descadastro: o
 * toque chega como TEXTO com o rótulo. Antes desta versão, o rótulo não era
 * pedido de saída — quem tocava seguia recebendo.
 */

const PEDE_PARA_SAIR = [
  "Parar mensagens",
  "parar mensagens",
  "PARAR MENSAGENS",
  "Parar mensagens.",
  "parar mensagem",
  "parar as mensagens",
  "Parar de receber mensagens",
  "parar de receber",
  "PARE DE MANDAR",
  "pare de mandar mensagem",
  "Pare de me mandar mensagens",
  "parem com as mensagens",
  "Não me mande mais",
  "nao me mande mais",
  "não me mande mais isso",
  "NÃO ME MANDE MAIS MENSAGEM",
  "Não quero mais receber",
  "nao quero mais receber",
  "não quero receber",
  "Não quero mais receber mensagens",
  "não mande mais mensagem",
  "nao mandem mais mensagens",
  "não envie mais mensagens",
  "cancelar mensagens",
  "Quero parar mensagens, por favor",
  // payload do botão sem rótulo
  "PARAR_MENSAGENS",
  "parar-mensagens",
];

const NAO_PEDE_PARA_SAIR = [
  "Sim, quero saber",
  "Não, obrigado",
  "não quero parar o processo",
  "tem como parar a dor?",
  "quero parar de pagar a taxa",
  "quanto custa?",
  "para mensagens de voz eu não consigo ouvir agora",
  "como cancelar mensagens agendadas?",
  "não me mande mais boleto, mande pix",
  "não mande mais nenhum documento por correio",
  "pode mandar mais mensagens",
  "recebi a mensagem, obrigado",
  "não recebi a mensagem",
  "vou parar a obra essa semana",
  "o INPI vai parar o meu pedido?",
  "ok",
  "bom dia",
];

describe("o botão Parar mensagens e as variações escritas", () => {
  it.each(PEDE_PARA_SAIR)("bloqueia: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto)).toBe(true);
    expect(ehOptOutProvavel(texto)).toBe(true);
    // o runtime do agente usa a mesma regra da ingestão
    expect(detectAmbiguousOptOut(texto)).toBe(true);
  });

  it.each(NAO_PEDE_PARA_SAIR)("frase comum não vira opt-out: %s", (texto) => {
    expect(ehPedidoDeOptOut(texto)).toBe(false);
    expect(ehOptOutProvavel(texto)).toBe(false);
  });
});

describe("o toque no botão, como a API oficial entrega", () => {
  const envelope = (message: Record<string, unknown>) =>
    ({
      object: "whatsapp_business_account",
      entry: [
        {
          id: "WABA1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { phone_number_id: "PNID1" },
                contacts: [{ wa_id: "5531900000001", profile: { name: "Ana" } }],
                messages: [{ from: "5531900000001", id: "wamid.BTN1", timestamp: "1785342028", ...message }],
              },
            },
          ],
        },
      ],
    }) as unknown as Parameters<typeof parseMetaWebhook>[0];

  const textoDoToque = (message: Record<string, unknown>): string | null => {
    const eventos = parseMetaWebhook(envelope(message)).filter(
      (e): e is InboundMessageEvent => e.kind === "inbound_message",
    );
    expect(eventos).toHaveLength(1);
    return eventos[0]!.text;
  };

  it("botão de modelo (quick reply) com rótulo e payload", () => {
    const texto = textoDoToque({ type: "button", button: { payload: "Parar mensagens", text: "Parar mensagens" } });
    expect(texto).toBe("Parar mensagens");
    expect(ehPedidoDeOptOut(texto)).toBe(true);
  });

  it("botão de modelo só com payload", () => {
    const texto = textoDoToque({ type: "button", button: { payload: "PARAR_MENSAGENS" } });
    expect(ehPedidoDeOptOut(texto)).toBe(true);
  });

  it("resposta interativa (button_reply)", () => {
    const texto = textoDoToque({
      type: "interactive",
      interactive: { type: "button_reply", button_reply: { id: "parar", title: "Parar mensagens" } },
    });
    expect(ehPedidoDeOptOut(texto)).toBe(true);
  });

  it("os outros dois botões do modelo não bloqueiam", () => {
    for (const rotulo of ["Sim, quero saber", "Não, obrigado"]) {
      const texto = textoDoToque({ type: "button", button: { payload: rotulo, text: rotulo } });
      expect(ehPedidoDeOptOut(texto)).toBe(false);
      expect(ehOptOutProvavel(texto)).toBe(false);
    }
  });
});
