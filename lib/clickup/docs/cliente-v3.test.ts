import { describe, expect, it, vi } from "vitest";

import { ClickUpDocsV3Client } from "./cliente-v3";

function resposta(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function respostaErro(status: number, headers?: HeadersInit) {
  return new Response(JSON.stringify({ err: "não expor" }), { status, headers });
}

describe("cliente ClickUp Docs v3", () => {
  it("pagina por cursor, omite privados por padrão e nunca põe token na URL", async () => {
    const urls: string[] = [];
    const headers: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      headers.push(String((init?.headers as Record<string, string>)?.Authorization));
      return urls.length === 1
        ? resposta({
            docs: [
              { id: "1", name: "Público" },
              { id: "2", name: "Privado", visibility: "PRIVATE" },
            ],
            next_cursor: "c2",
          })
        : resposta({ docs: [{ id: "3", name: "Segundo" }], next_cursor: null });
    });
    const checkpoints: Array<string | null> = [];
    const cliente = new ClickUpDocsV3Client({
      token: "token-super-secreto",
      workspaceId: "wk-1",
      fetchImpl: fetchImpl as typeof fetch,
      dormir: async () => undefined,
    });
    const docs = await cliente.listarDocs({
      aoCheckpoint: (cursor) => void checkpoints.push(cursor),
    });
    expect(docs.map((doc) => doc.id)).toEqual(["1", "3"]);
    expect(checkpoints).toEqual(["c2", null]);
    expect(urls[1]).toContain("cursor=c2");
    expect(urls.join(" ")).not.toContain("token-super-secreto");
    expect(headers).toEqual(["token-super-secreto", "token-super-secreto"]);
  });

  it("lista a árvore e busca cada página individual em Markdown", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/pages?"))
        return resposta({ pages: [{ id: "p1", name: "A", children: [{ id: "p2", name: "B" }] }] });
      if (url.includes("/p1?")) return resposta({ id: "p1", name: "A", content: "Texto A" });
      return resposta({
        id: "p2",
        name: "B",
        content: "Texto B",
        attachments: [{ id: "a1", name: "anexo.pdf", size: 10 }],
      });
    });
    const cliente = new ClickUpDocsV3Client({
      token: "token",
      workspaceId: "wk",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const exportado = await cliente.exportarDoc({
      id: "d1",
      name: "Doc",
      visibility: "PUBLIC",
      private: false,
      revision: null,
      raw: {},
    });
    expect(exportado.markdown).toBe("# A\n\nTexto A\n\n# B\n\nTexto B");
    expect(exportado.attachments).toEqual([
      expect.objectContaining({ id: "a1", page_id: "p2", name: "anexo.pdf" }),
    ]);
    expect(exportado.warnings).toContainEqual(
      expect.objectContaining({
        path: "page:p2.attachment:a1",
        code: "attachment_skipped_not_imported",
      }),
    );
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("aborta cursor repetido em vez de entrar em loop", async () => {
    const fetchImpl = vi.fn(async () => resposta({ docs: [], next_cursor: "ciclo" }));
    const cliente = new ClickUpDocsV3Client({
      token: "token",
      workspaceId: "wk",
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(cliente.listarDocs()).rejects.toThrow("clickup_v3_cursor_cycle");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403])("não repete resposta %s", async (status) => {
    const dormir = vi.fn(async () => undefined);
    const fetchImpl = vi.fn(async () => respostaErro(status));
    const cliente = new ClickUpDocsV3Client({
      token: "token",
      workspaceId: "wk",
      fetchImpl: fetchImpl as typeof fetch,
      dormir,
    });
    await expect(cliente.listarDocs()).rejects.toThrow(`clickup_v3_http_${status}`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(dormir).not.toHaveBeenCalled();
  });

  it("respeita Retry-After no 429", async () => {
    const dormir = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(respostaErro(429, { "retry-after": "2" }))
      .mockResolvedValueOnce(resposta({ docs: [], next_cursor: null }));
    const cliente = new ClickUpDocsV3Client({
      token: "token",
      workspaceId: "wk",
      fetchImpl: fetchImpl as typeof fetch,
      dormir,
    });
    await cliente.listarDocs();
    expect(dormir).toHaveBeenCalledWith(2_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
