import { describe, expect, it } from "vitest";

import {
  chaveExternaSchema,
  comSinalDeCapacidade,
  ehConflitoDaChave,
  escaparParaLike,
  INDICE_DA_CHAVE_EXTERNA,
  prefixoDeChaveSchema,
} from "@/lib/tarefas/chave-externa";

describe("chaveExternaSchema", () => {
  it.each([
    "a",
    "x".repeat(200),
    "dctfweb:12.345.678/0001-90:2026-12",
    "a b",
    "ação—ç",
    "😀".repeat(200),
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
    "😀".repeat(201),
  ])("recusa %j", (v) => expect(chaveExternaSchema.safeParse(v).success).toBe(false));
});

// D9 v2 (cxj D9-2 e §4): UMA regra, igual no zod e na constraint do banco. Proibidos: controles
// C0 e C1, os espaços Unicode (Zs menos U+0020, mais U+2028, U+2029 e U+FEFF) e o `*` (curinga do
// PostgREST no LIKE). Espaço ASCII nas pontas: proibido. A chave tem de estar em NFC.
describe("chaveExternaSchema — a regra de Unicode (D9 v2)", () => {
  it.each([
    "contab|rotina|6249|Folha/Pró-labore|09/2026", // chave canônica real, com acento
    "contab|rotina|6249|Carnê-leão|11/2026",
    "contab|cnd|6249|Federal",
    "contab|anual|6249|DEFIS/DASN|2026",
    "a\u200db", // ZWJ: invisível, mas não está na lista (emoji composto precisa dele)
    "👨\u200d👩",
  ])("aceita %j", (v) => expect(chaveExternaSchema.safeParse(v).success).toBe(true));

  it.each([
    ["asterisco no meio", "a*b"],
    ["só o asterisco", "*"],
    ["NBSP no fim", "a\u00a0"],
    ["NBSP no início", "\u00a0a"],
    ["NBSP no meio", "a\u00a0b"],
    ["EM SPACE no meio", "a\u2003b"],
    ["IDEOGRAPHIC SPACE no meio", "a\u3000b"],
    ["OGHAM SPACE MARK", "a\u1680b"],
    ["NARROW NBSP", "a\u202fb"],
    ["MEDIUM MATHEMATICAL SPACE", "a\u205fb"],
    ["LINE SEPARATOR", "a\u2028b"],
    ["PARAGRAPH SEPARATOR", "a\u2029b"],
    ["BOM / ZWNBSP", "a\ufeffb"],
    ["controle C1 (NEL)", "a\u0085b"],
    ["controle C1 (último)", "a\u009fb"],
    ["NFD: ó decomposto", "contab|rotina|6249|Pro\u0301-labore"],
    ["espaço ASCII no início", " a"],
    ["espaço ASCII no fim", "a "],
  ])("recusa %s", (_nome, v) => expect(chaveExternaSchema.safeParse(v).success).toBe(false));

  it("o NFC e o NFD da mesma palavra NÃO podem virar duas chaves: só o NFC passa", () => {
    const nfc = "Pró".normalize("NFC");
    const nfd = "Pró".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(chaveExternaSchema.safeParse(nfc).success).toBe(true);
    expect(chaveExternaSchema.safeParse(nfd).success).toBe(false);
  });
});

describe("prefixoDeChaveSchema — o prefixo segue a mesma regra", () => {
  it.each(["contab|rotina|6249|", "contab|rotina|6249|Folha/Pró", "a", "Folha de "])(
    "aceita %j (um prefixo pode terminar em espaço: é um pedaço, não uma chave)",
    (v) => expect(prefixoDeChaveSchema.safeParse(v).success).toBe(true),
  );
  it.each([
    "",
    "star*literal",
    "a\u00a0b",
    "\u00a0a",
    "Pro\u0301",
    "a\u0085",
    " a",
    "x".repeat(201),
  ])("recusa %j", (v) => expect(prefixoDeChaveSchema.safeParse(v).success).toBe(false));
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
