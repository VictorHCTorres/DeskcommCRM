import { describe, expect, it } from "vitest";

import { agentConfigSchema } from "@/lib/ai/guardrails-schema";
import { textoDoAviso } from "@/lib/escalacao/aviso-ao-lead";
import {
  dentroDoExpedienteDoAviso,
  EXPEDIENTE_PADRAO_DO_AVISO,
  lerExpedienteDoAviso,
  lerFraseDoAvisoConfigurada,
  TETO_DA_FRASE_DO_AVISO,
} from "@/lib/escalacao/frase-do-aviso-configurada";

/** O complemento da frase de passagem fora do horário de atendimento humano (1.110.2). */

const FRASE = "Já passei para o Victor, da nossa equipe; ele te responde por aqui.";
const COMPLEMENTO = "Ele te responde no próximo dia útil, a partir das 8h.";
const CONFIG = { aviso_de_handoff: FRASE, aviso_de_handoff_fora_do_horario: COMPLEMENTO };

// America/Sao_Paulo = UTC-3 (sem horário de verão)
const TERCA_10H = new Date("2026-11-17T13:00:00Z");
const TERCA_07H59 = new Date("2026-11-17T10:59:00Z");
const TERCA_08H = new Date("2026-11-17T11:00:00Z");
const TERCA_17H59 = new Date("2026-11-17T20:59:00Z");
const TERCA_18H = new Date("2026-11-17T21:00:00Z");
const QUINTA_21H = new Date("2026-11-20T00:00:00Z");
const SABADO_10H = new Date("2026-11-21T13:00:00Z");
const DOMINGO_23H = new Date("2026-11-23T02:00:00Z");

describe("sem o complemento configurado, nada muda", () => {
  it.each([TERCA_10H, TERCA_18H, SABADO_10H])("só a frase, a qualquer hora (%s)", (agora) => {
    expect(lerFraseDoAvisoConfigurada({ aviso_de_handoff: FRASE }, agora)).toBe(FRASE);
  });
  it("sem frase própria não há complemento: segue null (o aviso padrão do produto)", () => {
    expect(lerFraseDoAvisoConfigurada({ aviso_de_handoff_fora_do_horario: COMPLEMENTO }, SABADO_10H)).toBeNull();
  });
  it.each([null, 7, "", "   ", "...", "x".repeat(TETO_DA_FRASE_DO_AVISO + 1)])("complemento inválido é ignorado: %s", (c) => {
    expect(lerFraseDoAvisoConfigurada({ aviso_de_handoff: FRASE, aviso_de_handoff_fora_do_horario: c }, SABADO_10H)).toBe(FRASE);
  });
});

describe("com o complemento: segunda a sexta, 8h às 18h, por padrão", () => {
  it.each([TERCA_10H, TERCA_08H, TERCA_17H59])("dentro do horário sai só a frase (%s)", (agora) => {
    expect(lerFraseDoAvisoConfigurada(CONFIG, agora)).toBe(FRASE);
  });
  it.each([TERCA_07H59, TERCA_18H, QUINTA_21H, SABADO_10H, DOMINGO_23H])("fora do horário a frase ganha o complemento (%s)", (agora) => {
    expect(lerFraseDoAvisoConfigurada(CONFIG, agora)).toBe(`${FRASE} ${COMPLEMENTO}`);
  });
  it("é o texto que o cliente lê, inteiro, e o opt-out continua com a confirmação de saída", () => {
    const fora = lerFraseDoAvisoConfigurada(CONFIG, SABADO_10H);
    expect(textoDoAviso("pedido_de_humano", null, "lead-1", "pt-BR", fora)).toBe(`${FRASE} ${COMPLEMENTO}`);
    expect(textoDoAviso("suspeita_de_opt_out", null, "lead-1", "pt-BR", fora)).not.toContain("Victor");
  });
  it("as duas juntas acima do teto: sai só a frase", () => {
    const longa = "a".repeat(TETO_DA_FRASE_DO_AVISO - 10);
    expect(lerFraseDoAvisoConfigurada({ aviso_de_handoff: longa, aviso_de_handoff_fora_do_horario: COMPLEMENTO }, SABADO_10H)).toBe(longa);
  });
});

describe("o expediente configurado", () => {
  it("outro fuso e outros dias", () => {
    const config = { ...CONFIG, aviso_de_handoff_expediente: { fuso: "America/Manaus", dias: [1, 2, 3, 4, 5, 6], inicio: "09:00", fim: "12:00" } };
    // sábado 10h em São Paulo = 9h em Manaus: dentro
    expect(lerFraseDoAvisoConfigurada(config, SABADO_10H)).toBe(FRASE);
    // terça 8h em São Paulo = 7h em Manaus: fora
    expect(lerFraseDoAvisoConfigurada(config, TERCA_08H)).toBe(`${FRASE} ${COMPLEMENTO}`);
  });
  it.each([null, "x", [], { fuso: "Lua/Cratera", dias: [9], inicio: "25:00", fim: "8h" }, { dias: [] }])(
    "torto cai no padrão: %j",
    (valor) => {
      expect(lerExpedienteDoAviso(valor)).toEqual(EXPEDIENTE_PADRAO_DO_AVISO);
    },
  );
  it("o início entra e o fim não", () => {
    expect(dentroDoExpedienteDoAviso(TERCA_08H, EXPEDIENTE_PADRAO_DO_AVISO)).toBe(true);
    expect(dentroDoExpedienteDoAviso(TERCA_18H, EXPEDIENTE_PADRAO_DO_AVISO)).toBe(false);
  });
});

describe("o PATCH do agente aceita as chaves novas", () => {
  it("guarda o complemento e o expediente", () => {
    const r = agentConfigSchema.partial().safeParse({
      aviso_de_handoff: FRASE,
      aviso_de_handoff_fora_do_horario: COMPLEMENTO,
      aviso_de_handoff_expediente: { fuso: "America/Fortaleza", dias: [1, 2, 3, 4, 5], inicio: "08:00", fim: "18:00" },
    });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.aviso_de_handoff_fora_do_horario).toBe(COMPLEMENTO);
  });
  it("recusa hora torta", () => {
    expect(agentConfigSchema.partial().safeParse({ aviso_de_handoff_expediente: { inicio: "8h" } }).success).toBe(false);
  });
});
