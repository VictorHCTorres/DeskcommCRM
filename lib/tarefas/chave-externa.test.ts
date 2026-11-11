import { describe, expect, it } from "vitest";

import {
  chaveExternaSchema,
  comSinalDeCapacidade,
  ehConflitoDaChave,
  escaparParaLike,
  INDICE_DA_CHAVE_EXTERNA,
  prefixoDeChaveSchema,
  valorDoFiltroIn,
} from "@/lib/tarefas/chave-externa";

describe("chaveExternaSchema", () => {
  it.each([
    "a",
    "x".repeat(200),
    "dctfweb:12.345.678/0001-90:2026-12",
    "ação-ç",
    "Ç".repeat(200),
  ])("aceita %s", (v) => expect(chaveExternaSchema.safeParse(v).success).toBe(true));

  it.each([
    "",
    " a",
    "a ",
    "a\t",
    "a\nb",
    "a\u0000b",
    "a\u007fb",
    "x".repeat(201),
    "ç".repeat(201),
    "😀",
    "ação—ç", // travessão (U+2014) está fora da lista
  ])("recusa %j", (v) => expect(chaveExternaSchema.safeParse(v).success).toBe(false));
});

// D9 v3 (cxj D9v2-2): o domínio é uma LISTA de caracteres permitidos, idêntica à constraint do
// banco: ASCII [A-Za-z0-9] e `| / . : -`, SEM espaço, e as letras pré-compostas do
// Latin-1 (U+00C0–U+00FF, menos × e ÷). Não há normalize(): a NFC difere entre o PostgreSQL 15 e o
// Node (o cxj achou 20 caracteres), e o pré-composto do Latin-1 é NFC em qualquer versão.
describe("chaveExternaSchema — o domínio por lista (D9 v3)", () => {
  it.each([
    "contab|rotina|6249|Folha/Pró-labore|09/2026", // chave canônica real, com acento
    "contab|rotina|6249|Carnê-leão|11/2026",
    "contab|cnd|6249|Federal",
    "contab|anual|6249|DEFIS/DASN|2026",
    "contab|ref|86ajtpeqc",
    "marca|prazo|935800921|manifestar-nulidade|2027-01-07",
    "a:b.c-d/e|f",
    "\u00c0\u00d6\u00d8\u00f6\u00f8\u00ff", // as pontas das faixas do Latin-1
  ])("aceita %j", (v) => expect(chaveExternaSchema.safeParse(v).success).toBe(true));

  it.each([
    ["asterisco", "a*b"],
    ["só o asterisco", "*"],
    ["aspa dupla", 'a"b'],
    ["barra invertida", "a\\b"],
    ["vírgula", "a,b"],
    ["parênteses", "a(b)"],
    ["mais, porcento, interrogação, jogo-da-velha, e comercial, igual", "a+b"],
    ["porcento", "a%b"],
    ["interrogação", "a?b"],
    ["cerquilha", "a#b"],
    ["e comercial", "a&b"],
    ["igual", "a=b"],
    ["sublinhado", "a_b"],
    ["crase", "a`b"],
    ["multiplicação ×", "a\u00d7b"],
    ["divisão ÷", "a\u00f7b"],
    ["NBSP no fim", "a\u00a0"],
    ["NBSP no meio", "a\u00a0b"],
    ["EM SPACE", "a\u2003b"],
    ["LINE SEPARATOR", "a\u2028b"],
    ["BOM", "a\ufeffb"],
    ["controle C1", "a\u0085b"],
    ["ZWJ (largura zero)", "a\u200db"],
    ["WORD JOINER", "a\u2060b"],
    ["marca combinante: ó decomposto (NFD)", "contab|rotina|6249|Pro\u0301-labore"],
    ["outra escrita: dígito arábico-índico", "a\u0662b"],
    ["dígito de largura total", "a\uff16b"],
    ["emoji", "a😀b"],
    ["surrogate alto isolado (era 500)", "k:\ud800"],
    ["surrogate baixo isolado", "k:\udc00"],
    ["o par de U+105D2 com ponto (o caso do cxj)", "k:\u{105D2}\u0307"],
    ["espaço ASCII no início", " a"],
    ["espaço ASCII no fim", "a "],
    ["espaço ASCII no meio (decisão: sem espaço nenhum)", "a b"],
  ])("recusa %s", (_nome, v) => expect(chaveExternaSchema.safeParse(v).success).toBe(false));

  it("a mesma palavra em NFC passa e em NFD não: nunca há duas chaves para o mesmo texto", () => {
    const nfc = "Pró".normalize("NFC");
    const nfd = "Pró".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(chaveExternaSchema.safeParse(nfc).success).toBe(true);
    expect(chaveExternaSchema.safeParse(nfd).success).toBe(false);
  });

  it("todo caractere permitido é NFC em si (a premissa de dispensar o normalize)", () => {
    for (let cp = 0x20; cp <= 0xff; cp++) {
      const c = String.fromCodePoint(cp);
      if (chaveExternaSchema.safeParse(`a${c}b`).success) expect(c.normalize("NFC")).toBe(c);
    }
  });
});

describe("prefixoDeChaveSchema — o prefixo segue o mesmo domínio", () => {
  it.each(["contab|", "contab|rotina|", "contab|anual|", "contab|cnd|", "contab|rotina|6249|Folha/Pró", "a"])(
    "aceita %j",
    (v) => expect(prefixoDeChaveSchema.safeParse(v).success).toBe(true),
  );
  it.each([
    "",
    "star*literal",
    'a"b',
    "a\\b",
    "a,b",
    "a\u00a0b",
    "\u00a0a",
    "Pro\u0301",
    "a\u0085",
    "k:\ud800",
    " a",
    "Folha de ",
    "x".repeat(201),
  ])("recusa %j", (v) => expect(prefixoDeChaveSchema.safeParse(v).success).toBe(false));
});

// D9v2-1 (cxj): o `.in()` do supabase-js não escapa `"` nem `\`; o PostgREST lia outra expressão.
describe("valorDoFiltroIn", () => {
  it("põe SEMPRE entre aspas e escapa a barra e a aspa, nessa ordem", () => {
    expect(valorDoFiltroIn(["a", "b"])).toBe('("a","b")');
    expect(valorDoFiltroIn(["k:a,b\\c"])).toBe('("k:a,b\\\\c")');
    expect(valorDoFiltroIn(['k:a",b'])).toBe('("k:a\\",b")');
    expect(valorDoFiltroIn(['k:a\\",b'])).toBe('("k:a\\\\\\",b")');
    expect(valorDoFiltroIn(["k:a(b)"])).toBe('("k:a(b)")');
  });
});

describe("escaparParaLike", () => {
  it("escapa barra, porcentagem e sublinhado", () => {
    expect(escaparParaLike("100%_a\\b")).toBe("100\\%\\_a\\\\b");
    expect(escaparParaLike("sem curinga")).toBe("sem curinga");
  });
});

describe("ehConflitoDaChave", () => {
  it("só reconhece o 23505 que cita o índice da chave", () => {
    const msg = `duplicate key value violates unique constraint "${INDICE_DA_CHAVE_EXTERNA}"`;
    expect(ehConflitoDaChave({ code: "23505", message: msg })).toBe(true);
    expect(ehConflitoDaChave({ code: "23505", message: "x", details: msg })).toBe(true);
    expect(ehConflitoDaChave({ code: "23505", message: 'unique constraint "outro"' })).toBe(false);
    expect(ehConflitoDaChave({ code: "23503", message: msg })).toBe(false);
    expect(ehConflitoDaChave(null)).toBe(false);
  });
});

describe("comSinalDeCapacidade", () => {
  it("põe o cabeçalho, também em resposta de cabeçalhos imutáveis", () => {
    expect(comSinalDeCapacidade(new Response("{}")).headers.get("x-tasks-external-id")).toBe("1");
    const imutavel = Response.redirect("https://exemplo.test/", 302);
    expect(comSinalDeCapacidade(imutavel).headers.get("x-tasks-external-id")).toBe("1");
  });
});
