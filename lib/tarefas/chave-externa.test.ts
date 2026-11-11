import { describe, expect, it } from "vitest";

import {
  chaveExternaSchema,
  comSinalDeCapacidade,
  ehConflitoDaChave,
  escaparParaLike,
  INDICE_DA_CHAVE_EXTERNA,
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
