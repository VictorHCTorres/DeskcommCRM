import { describe, expect, it, vi } from "vitest";

import {
  conferirRespostaDaLinhaA,
  lerExcecaoFunilA,
  normalizarPreco,
  OPCAO_EXCECAO_FUNIL_A,
  resolverExcecaoFunilA,
  type ExcecaoFunilA,
  type FatosDaExcecao,
} from "@/lib/escalacao/excecao-funil-a";

const NEGOCIO: ExcecaoFunilA = {
  precoCentavos: 69700,
  codigo: "xjvx5klebf",
  linkPagina: "https://suindara.example/a3/xjvx5klebf",
};
const MILHAR: ExcecaoFunilA = { precoCentavos: 199700, codigo: "srzccmiqn3", linkPagina: null };

const passa = (body: string, n: ExcecaoFunilA = NEGOCIO): void => {
  expect(conferirRespostaDaLinhaA(body, n)).toEqual({ ok: true });
};
const barra = (body: string, motivo: string, n: ExcecaoFunilA = NEGOCIO): void => {
  const r = conferirRespostaDaLinhaA(body, n);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.motivos).toContain(motivo);
};

describe("normalizarPreco — o campo preco do negócio, em centavos", () => {
  it.each([
    ["R$ 697", 69700],
    ["R$ 1.997", 199700],
    ["R$697,00", 69700],
    ["R$ 1.997,00", 199700],
    ["697", 69700],
    ["697.00", 69700],
    ["697 reais", 69700],
    [497, 49700],
  ])("%s → %i", (valor, centavos) => {
    expect(normalizarPreco(valor)).toBe(centavos);
  });

  it.each(["", "   ", "a combinar", "R$", "R$ 0", "697 ou 797", null, undefined, {}, 0, -5])(
    "vazio ou ilegível não é preço: %s",
    (valor) => {
      expect(normalizarPreco(valor)).toBeNull();
    },
  );
});

describe("conferirRespostaDaLinhaA — o preço exato passa", () => {
  it.each([
    "São R$ 697, com a taxa do INPI à parte, se houver. A gente prepara o recurso e entrega no INPI em até 7 dias depois do Pix e de duas perguntas rápidas. Posso pedir o Pix?",
    "O recurso sai por R$ 697, com a taxa do INPI à parte, se houver, em até 7 dias.",
    "Não: os R$ 697 são só o nosso trabalho; a taxa do INPI, se houver, é à parte. Posso pedir o Pix?",
    "Não consigo mexer no valor: é fixo por porte de empresa, R$ 697, só por Pix. Peço o Pix?",
    "Também não tenho como: é pagamento único, só por Pix. Quer seguir assim?",
    "Combinado. O Victor, da nossa equipe, te manda aqui ainda hoje o Pix de R$ 697, em nome da Suindara, referência funilA:xjvx5klebf. Foi você mesmo quem fez o pedido da marca?",
    "Faz bem em conferir. Somos a Suindara Consultoria, CNPJ 12.345.678/0001-90; o processo 931011302 é público em busca.inpi.gov.br, e o Pix sai em nome da Suindara, nunca do INPI.",
    "Pode encaminhar: a Suindara prepara e entrega no INPI o recurso da ELÉTRICA PEREIRA por R$ 697, com a taxa do INPI à parte, se houver, em até 7 dias, de preferência até 14/11. https://suindara.example/a3/xjvx5klebf",
    "O INPI negou o pedido da marca ELÉTRICA PEREIRA; cabe recurso até 23/11, pela publicação, e sem ele a negativa fica definitiva. Quer saber como resolver e quanto custa?",
    "Custa R$ 697,00.",
    "Fica em 697 reais.",
    "O valor é R$697.",
    "Sai por 697.",
    "Da sua parte é pouco: o Pix e duas perguntas rápidas.",
    "A decisão é do INPI, e ninguém pode prometer resultado. O nosso compromisso é o recurso bem feito e entregue no prazo.",
    "Às vezes o INPI demora para decidir. Faz sentido para você?",
  ])("sai: %s", (body) => passa(body));

  it.each(["São R$ 1.997, com a taxa do INPI à parte.", "Custa R$ 1.997,00.", "Sai por 1.997.", "São 1.997 reais."])(
    "preço com milhar sai: %s",
    (body) => passa(body, MILHAR),
  );

  it("por extenso, o próprio preço sai", () => {
    passa("São seiscentos e noventa e sete reais.");
    passa("São mil novecentos e noventa e sete reais.", MILHAR);
  });
});

describe("conferirRespostaDaLinhaA — outro valor barra", () => {
  it.each([
    "Consigo fazer por R$ 600.",
    "São R$ 697, mas a taxa do INPI é R$ 440.",
    "O valor é R$ 697,50.",
    "Custa R$ 6.970.",
    "Fica em 500 reais.",
    "Sai por 500.",
    "São 1.997 reais.",
    "O registro custa R$ 1.997 e o recurso R$ 697.",
    "Te faço 650,00.",
    "Fecho em 2 mil.",
    "Custa quinhentos reais.",
    "São seiscentos e noventa reais.",
    "Sai por quatrocentos e noventa e sete.",
    "A tabela é R$ 2.100 para recurso.",
  ])("barra: %s", (body) => barra(body, "valor_diferente_do_preco"));

  it.each(["O valor é R$ a combinar.", "São 100 dólares.", "Custa US$ 130.", "Fica em 120 euros."])(
    "valor que não dá para ler barra: %s",
    (body) => barra(body, "valor_ilegivel"),
  );
});

describe("conferirRespostaDaLinhaA — condição comercial barra, mesmo com o preço certo", () => {
  it.each([
    ["Consigo um desconto: R$ 697.", "desconto"],
    ["Não temos desconto.", "desconto"],
    ["Posso fazer um abatimento.", "abatimento"],
    ["Está em promoção: R$ 697.", "promocao"],
    ["Valor promocional de R$ 697.", "promocao"],
    ["Dá para parcelar os R$ 697.", "parcelamento"],
    ["São 2 parcelas.", "parcelamento"],
    ["Pode ser em 3 vezes.", "n_vezes"],
    ["Pode ser em duas vezes.", "n_vezes"],
    ["Fazemos em 3x.", "n_x"],
    ["12x de 58", "n_x"],
    ["R$ 697 sem juros.", "juros"],
    ["Aceitamos cartão.", "cartao"],
    ["Pode pagar no crédito.", "cartao"],
    ["Mando o boleto de R$ 697.", "boleto"],
    ["Tem 10% a menos para você.", "porcentagem"],
    ["Dez por cento a menos.", "porcentagem"],
    ["De R$ 997 por R$ 697.", "de_por"],
    ["A análise é grátis.", "gratis"],
    ["A consulta é gratuita.", "gratis"],
    ["Fazemos de graça.", "gratis"],
  ])("barra: %s (%s)", (body, motivo) => barra(body, motivo));
});

describe("conferirRespostaDaLinhaA — promessa barra", () => {
  it.each([
    ["Tem garantia: R$ 697.", "garantia"],
    ["O registro é garantido.", "garantia"],
    ["Garantimos a aprovação.", "garantia"],
    ["É aprovação certa.", "aprovacao_certa"],
    ["Está tudo incluído nos R$ 697.", "tudo_incluido"],
    ["Tudo incluso.", "tudo_incluido"],
  ])("barra: %s (%s)", (body, motivo) => barra(body, motivo));
});

describe("conferirRespostaDaLinhaA — chave Pix, copia-e-cola e link de pagamento barram", () => {
  it.each([
    ["A chave Pix é o CNPJ 12.345.678/0001-90.", "chave_pix"],
    ["Segue o Pix copia e cola.", "copia_e_cola"],
    ["Pix copia-e-cola abaixo.", "copia_e_cola"],
    ["00020126580014br.gov.bcb.pix0136123e4567-e89b-12d3-a456-4266141740005204000053039865802BR", "copia_e_cola"],
    ["Aponte a câmera para o QR code.", "copia_e_cola"],
    ["Segue o link de pagamento.", "link_de_pagamento"],
    ["O link para pagar é este.", "link_de_pagamento"],
    ["Pague em https://www.asaas.com/c/abc123", "endereco_nao_permitido"],
    ["Pague em asaas.com/c/abc123", "endereco_nao_permitido"],
    ["https://suindara.example/pagar/xjvx5klebf", "endereco_nao_permitido"],
    ["Faça o Pix para financeiro@suindara.com.br", "email"],
    ["Pix para 123e4567-e89b-12d3-a456-426614174000", "chave_aleatoria"],
    ["Pix para o CPF 123.456.789-09", "cpf"],
    ["Pix para (88) 99999-1234", "telefone"],
    ["Pix para 88999991234", "telefone"],
  ])("barra: %s (%s)", (body, motivo) => barra(body, motivo));

  it("as palavras Pix e pagamento, sozinhas, saem", () => {
    passa("O pagamento é único, só por Pix.");
  });

  it("o link_pagina do negócio e o site do INPI saem; o processo de 9 dígitos não é telefone", () => {
    passa("Os detalhes: https://suindara.example/a3/xjvx5klebf");
    passa("O processo 931011302 é público em busca.inpi.gov.br.");
    passa("Veja em https://busca.inpi.gov.br/pePI/");
  });

  it("sem link_pagina no negócio, nenhum endereço próprio sai", () => {
    barra("Os detalhes: https://suindara.example/a3/xjvx5klebf", "endereco_nao_permitido", MILHAR);
  });
});

describe("conferirRespostaDaLinhaA — a referência é funilA:<codigo do negócio>", () => {
  it("a do negócio sai, com maiúsculas e espaço", () => {
    passa("Referência funilA:xjvx5klebf.");
    passa("referência FunilA: XJVX5KLEBF");
  });
  it.each([
    ["Referência funilA:outrocodigo.", "referencia_diferente_do_codigo"],
    ["Referência funilA:xjvx5klebf2.", "referencia_diferente_do_codigo"],
    ["Referência funilA:", "referencia_diferente_do_codigo"],
    ["A referência do Pix é 12345.", "referencia_sem_codigo"],
    ["Use a referência Suindara.", "referencia_sem_codigo"],
  ])("barra: %s (%s)", (body, motivo) => barra(body, motivo));
  it("negócio sem codigo: nenhuma referência sai", () => {
    barra("Referência funilA:xjvx5klebf.", "referencia_diferente_do_codigo", { ...NEGOCIO, codigo: null });
  });
});

describe("conferirRespostaDaLinhaA — os motivos são rótulos, nunca o trecho", () => {
  it("não devolve o texto barrado", () => {
    const r = conferirRespostaDaLinhaA("Desconto de 10% para Maria: R$ 600 no cartão.", NEGOCIO);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.motivos.sort()).toEqual(["cartao", "desconto", "porcentagem", "valor_diferente_do_preco"]);
      expect(r.motivos.join(" ")).not.toMatch(/maria|600/iu);
    }
  });
});

const FATOS: FatosDaExcecao = {
  opcaoLigada: true,
  etiquetas: ["cliente", "funil-a"],
  negociosAbertos: [
    { funilNome: "Prospecção", funilSlug: "prospeccao", campos: { preco: "R$ 697", codigo: "xjvx5klebf", servico: "A3", link_pagina: "https://suindara.example/a3/xjvx5klebf" } },
  ],
};

describe("resolverExcecaoFunilA — a condição inteira", () => {
  it("tudo junto: há exceção, com preço, código e link", () => {
    expect(resolverExcecaoFunilA(FATOS)).toEqual(NEGOCIO);
  });
  it("o funil vale pelo nome (com acento e caixa) ou pelo slug", () => {
    const campos = FATOS.negociosAbertos[0]!.campos;
    expect(resolverExcecaoFunilA({ ...FATOS, negociosAbertos: [{ funilNome: "PROSPECCAO", funilSlug: "funil-2", campos }] })).not.toBeNull();
    expect(resolverExcecaoFunilA({ ...FATOS, negociosAbertos: [{ funilNome: "Linha A", funilSlug: "prospeccao", campos }] })).not.toBeNull();
  });
  it("negócio aberto em OUTRO funil não conta nem atrapalha", () => {
    const outro = { funilNome: "Vendas", funilSlug: "vendas", campos: { preco: "R$ 1.997" } };
    expect(resolverExcecaoFunilA({ ...FATOS, negociosAbertos: [...FATOS.negociosAbertos, outro] })).toEqual(NEGOCIO);
    expect(resolverExcecaoFunilA({ ...FATOS, negociosAbertos: [outro] })).toBeNull();
  });

  it.each<[string, Partial<FatosDaExcecao>]>([
    ["opção desligada", { opcaoLigada: false }],
    ["contato sem a etiqueta funil-a", { etiquetas: ["cliente", "funil-b"] }],
    ["nenhum negócio aberto", { negociosAbertos: [] }],
    ["dois negócios abertos na Prospecção", { negociosAbertos: [...FATOS.negociosAbertos, ...FATOS.negociosAbertos] }],
    ["preco vazio", { negociosAbertos: [{ funilNome: "Prospecção", funilSlug: "prospeccao", campos: { preco: " ", codigo: "x" } }] }],
    ["preco ausente", { negociosAbertos: [{ funilNome: "Prospecção", funilSlug: "prospeccao", campos: { codigo: "x" } }] }],
    ["preco ilegível", { negociosAbertos: [{ funilNome: "Prospecção", funilSlug: "prospeccao", campos: { preco: "a combinar" } }] }],
    ["campos nulos", { negociosAbertos: [{ funilNome: "Prospecção", funilSlug: "prospeccao", campos: null }] }],
  ])("sem exceção: %s", (_nome, mudanca) => {
    expect(resolverExcecaoFunilA({ ...FATOS, ...mudanca })).toBeNull();
  });
});

describe("lerExcecaoFunilA — a leitura", () => {
  const ORG = "00000000-0000-4000-8000-000000000001";
  const CONTATO = "00000000-0000-4000-8000-000000000002";
  const banco = (opcao: unknown[], contato: unknown[] | Error) => {
    const query = vi.fn(async (sql: string, _v: unknown[]) => {
      if (sql.includes("org_guardrail_layers")) return { rows: opcao as Array<Record<string, unknown>> };
      if (contato instanceof Error) throw contato;
      return { rows: contato as Array<Record<string, unknown>> };
    });
    return { query };
  };
  const LINHA = {
    etiquetas: ["funil-a"],
    negocios: [{ funil_nome: "Prospecção", funil_slug: "prospeccao", campos: { preco: "R$ 697", codigo: "xjvx5klebf" } }],
  };

  it("sem linha da opção (o estado de todo deploy): null, e NÃO lê contato nem negócio", async () => {
    const db = banco([], [LINHA]);
    expect(await lerExcecaoFunilA(db, ORG, CONTATO)).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0]![1]).toEqual([ORG, OPCAO_EXCECAO_FUNIL_A]);
  });
  it("opção com enabled=false: null", async () => {
    const db = banco([{ enabled: false }], [LINHA]);
    expect(await lerExcecaoFunilA(db, ORG, CONTATO)).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });
  it("opção ligada e condição completa: devolve o negócio, filtrando organização e contato", async () => {
    const db = banco([{ enabled: true }], [LINHA]);
    expect(await lerExcecaoFunilA(db, ORG, CONTATO)).toEqual({ precoCentavos: 69700, codigo: "xjvx5klebf", linkPagina: null });
    expect(db.query.mock.calls[1]![1]).toEqual([ORG, CONTATO]);
    expect(String(db.query.mock.calls[1]![0])).toMatch(/l\.status = 'open'/u);
  });
  it("opção ligada, contato sem etiqueta: null", async () => {
    const db = banco([{ enabled: true }], [{ ...LINHA, etiquetas: [] }]);
    expect(await lerExcecaoFunilA(db, ORG, CONTATO)).toBeNull();
  });
  it("contato não encontrado: null", async () => {
    expect(await lerExcecaoFunilA(banco([{ enabled: true }], []), ORG, CONTATO)).toBeNull();
  });
  it("leitura que estoura: null (falha fechada) e avisa", async () => {
    const avisar = vi.fn();
    expect(await lerExcecaoFunilA(banco([{ enabled: true }], new Error("banco fora do ar")), ORG, CONTATO, avisar)).toBeNull();
    expect(avisar).toHaveBeenCalledTimes(1);
  });
});
