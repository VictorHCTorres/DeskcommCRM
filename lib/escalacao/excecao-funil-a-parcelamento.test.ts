import { describe, expect, it } from "vitest";
import { conferirRespostaDaLinhaA, resolverExcecaoFunilA, PARCELAS_MAX } from "./excecao-funil-a";

const BASE = { precoCentavos: 69700, codigo: "tstvictor1", linkPagina: null };
const COM = { ...BASE, parcelasMax: PARCELAS_MAX };

const PASSAM = [
  "A gente prepara o recurso, entrega no INPI em até 7 dias e acompanha até a decisão. Sai por R$ 697 (taxa do INPI à parte, se houver), no Pix ou em até 6x no cartão. Te mando o link de pagamento?",
  "Parcela sim: em até 6x sem juros no cartão de crédito, ou à vista no Pix. Te mando o link de pagamento?",
  "Vai até 6x, sem juros; o valor exato de cada parcela aparece no link de pagamento, antes de você confirmar.",
  "Pode: você escolhe o número de parcelas no link de pagamento, até 6x.",
  "Por aqui é só à vista no Pix ou no cartão de crédito em até 6x, pelo link de pagamento da Suindara.",
  "Parece que o valor pesou. Dá para dividir em até 6x no cartão; recomeçar do zero teria taxa nova e perderia a data do pedido atual.",
  "O valor é fixo por porte de empresa, R$ 697, mas dá para dividir em até 6x no cartão. Quer seguir assim?",
  "Perfeito. O Victor, da nossa equipe, te manda aqui ainda hoje o link de pagamento de R$ 697, em nome da Suindara, referência funilA:tstvictor1. Foi você mesmo quem fez o pedido da marca?",
  "O seu pedido já está com o Victor, e o link de pagamento vem por aqui, em nome da Suindara.",
  "Dá para pagar em 6 vezes no cartão.",
  "O recurso, entregue no INPI em até 3 dias, sai por R$ 697, no Pix ou em até 6x no cartão. Quer seguir?",
];

const BARRAM: Array<[string, string]> = [
  ["valor de parcela", "Em 6x de R$ 116,16 no cartão."],
  ["valor de parcela por extenso", "Fica 6x de cento e dezesseis reais."],
  ["acima do teto", "Dá para fazer em 10x no cartão."],
  ["acima do teto por extenso", "Pode parcelar em doze vezes."],
  ["12 parcelas", "Fazemos em 12 parcelas."],
  ["com juros", "Em 6x com juros de cartão."],
  ["débito", "Pode ser no débito ou crédito."],
  ["boleto continua", "Aceitamos boleto em até 6x."],
  ["desconto continua", "No Pix tem desconto."],
  ["URL de pagamento continua", "Paga aqui: https://www.asaas.com/c/abc123"],
  ["outro valor", "Sai por R$ 597 em até 6x."],
  ["garantia continua", "Parcelado em até 6x, com garantia."],
];

describe("Linha A — parcelamento até 6x (opção LIGADA)", () => {
  it.each(PASSAM)("passa: %s", (t) => expect(conferirRespostaDaLinhaA(t, COM)).toEqual({ ok: true }));
  it.each(BARRAM)("barra: %s", (_n, t) => expect(conferirRespostaDaLinhaA(t, COM).ok).toBe(false));
});

describe("Linha A — opção DESLIGADA: igual à 1.110.2", () => {
  it.each(PASSAM.filter((t) => /6x|6 vezes|parcel|cartao|cartão|link de pagamento|juros/iu.test(t)))("barra: %s", (t) =>
    expect(conferirRespostaDaLinhaA(t, BASE).ok).toBe(false));
  it("resolver sem a opção não põe parcelasMax", () => {
    const r = resolverExcecaoFunilA({ opcaoLigada: true, etiquetas: ["funil-a"], negociosAbertos: [{ funilNome: "Prospecção", funilSlug: null, campos: { preco: "R$ 697", codigo: "x" } }] });
    expect(r && "parcelasMax" in r).toBe(false);
  });
  it("resolver com a opção põe parcelasMax = 6", () => {
    const r = resolverExcecaoFunilA({ opcaoLigada: true, parcelamentoLigado: true, etiquetas: ["funil-a"], negociosAbertos: [{ funilNome: "Prospecção", funilSlug: null, campos: { preco: "R$ 697", codigo: "x" } }] });
    expect(r?.parcelasMax).toBe(6);
  });
});
