/**
 * A FIAÇÃO DA SAÍDA DO AGENTE ATÉ O HANDLER (F4v do cxj, 12/11/2026, V01; versão 17).
 *
 * A cadeia (`runBeforeSend`) roda o transporte com a saída no escopo (`comSaidaDoAgente`), e o handler a toma no
 * último passo (`tomarSaidaDoAgente`). Entre os dois está o envio do turno (`sendTurnMessage`): a leitura do job e da
 * fronteira, o ledger (`sendWithLedger`) e a chamada do handler, tudo no mesmo processo, numa cadeia de esperas. É o
 * que faz o escopo chegar. Se esse caminho passar por uma fila, por outro processo ou por uma chamada de rede, o
 * handler deixa de achar a saída e para de conferir a idade dela, em silêncio. Esta cerca cobra que ela chega.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMessageHandlerMock } = vi.hoisted(() => ({ sendMessageHandlerMock: vi.fn() }));

vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: sendMessageHandlerMock }));

import { sendTurnMessage, type SendMessageInput } from "@/lib/agent-engine/edge/crm/send-message";
import {
  ATRASO_MAXIMO_DA_SAIDA_DO_AGENTE_MS as FOLGA,
  comSaidaDoAgente,
  novaSaidaDoAgente,
  tomarSaidaDoAgente,
  type SaidaDoAgente,
} from "@/lib/agent-engine/pacing/saida-do-agente";

const AGORA = new Date("2026-11-18T14:00:00Z");
const FRONTEIRA = {
  organization_id: "org1",
  contact_id: "contact1",
  conversation_id: "conv1",
  service_revision: 1,
  demanda_id: null,
  demanda_revision: null,
};

/** O banco do envio do turno, como em `send-turn-message-voz.test.ts`: o job com a fronteira e o ledger sem linha. */
function dbComJob() {
  return {
    query: vi.fn(async (text: string) => {
      if (text.includes("from job_queue")) {
        return { rows: [{ kind: "agent_turn", payload: { service_boundary: FRONTEIRA } }], rowCount: 1 } as never;
      }
      if (text.includes("insert into send_ledger")) return { rows: [{ id: "ledger-key-1" }], rowCount: 1 } as never;
      if (text.includes("from messages")) return { rows: [], rowCount: 0 } as never;
      return { rows: [{ ...FRONTEIRA, status: "open", demanda_fechada_em: null }], rowCount: 1 } as never;
    }),
  };
}
const cfg = { supabase: {} as never };
const entrada = (seq: number): SendMessageInput => ({
  tenantId: "org1",
  leadId: "contact1",
  jobId: "job1",
  seq,
  conversationId: "conv1",
  body: "Uma resposta de texto.",
});

/** O que o handler acha no escopo, a cada mensagem física que chega a ele. */
let achadas: Array<SaidaDoAgente | null>;
beforeEach(() => {
  achadas = [];
  sendMessageHandlerMock.mockReset();
  sendMessageHandlerMock.mockImplementation(async () => {
    achadas.push(tomarSaidaDoAgente());
    return { id: "msg1", status: "sent" };
  });
});

describe("a saída do agente chega ao handler pelo envio do turno (F4v, V01)", () => {
  it("dentro do escopo da cadeia, o handler acha a saída na 1ª mensagem física, e não na 2ª", async () => {
    const saida = novaSaidaDoAgente(AGORA, FOLGA, () => AGORA);
    await comSaidaDoAgente(saida, async () => {
      // O ledger deste banco falso não fecha o envio: o que se cobra é o que o handler achou ao ser chamado.
      await sendTurnMessage(dbComJob(), cfg, entrada(1)).catch(() => {});
      await sendTurnMessage(dbComJob(), cfg, entrada(2)).catch(() => {});
    });
    expect(sendMessageHandlerMock).toHaveBeenCalledTimes(2);
    expect(achadas).toEqual([saida, null]);
  });

  it("controle: fora da cadeia do agente, o handler não acha saída nenhuma", async () => {
    await sendTurnMessage(dbComJob(), cfg, entrada(1)).catch(() => {});
    expect(sendMessageHandlerMock).toHaveBeenCalledTimes(1);
    expect(achadas).toEqual([null]);
  });
});
