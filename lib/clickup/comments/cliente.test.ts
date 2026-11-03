import { describe, expect, it, vi } from "vitest";

import { ClienteDeComentariosClickUp } from "./cliente";

const resposta = (valor: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(valor), { status, headers });

function comentario(indice: number, extras: Record<string, unknown> = {}) {
  return {
    id: `c${String(indice).padStart(2, "0")}`,
    date: String(1_730_619_000_000 - indice),
    comment_text: `Comentário ${indice}`,
    ...extras,
  };
}

describe("paginação dos comentários ClickUp", () => {
  it("pagina além de 25 com start+start_id e preserva replies após o pai", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/comment/c05/reply")) {
        return resposta({ comments: [comentario(100, { id: "r1" })] });
      }
      if (url.includes("start_id=")) return resposta({ comments: [comentario(26)] });
      return resposta({
        comments: Array.from({ length: 25 }, (_, indice) =>
          comentario(indice + 1, indice === 4 ? { reply_count: 1 } : {}),
        ),
      });
    });
    const cliente = new ClienteDeComentariosClickUp({
      token: "segredo",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const resultado = await cliente.listarDaTask("t1");
    expect(resultado.topLevelCount).toBe(26);
    expect(resultado.repliesCount).toBe(1);
    expect(urls[1]).toContain("start=1730618999975");
    expect(urls[1]).toContain("start_id=c25");
    const pai = resultado.comments.findIndex((item) => item.comment_id === "c05");
    const reply = resultado.comments.findIndex((item) => item.comment_id === "r1");
    expect(reply).toBe(pai + 1);
    expect(urls.join(" ")).not.toContain("segredo");
  });

  it("não repete 401/403 e respeita Retry-After no 429", async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => resposta({}, status));
      const cliente = new ClienteDeComentariosClickUp({
        token: "x",
        fetchImpl: fetchImpl as typeof fetch,
      });
      await expect(cliente.listarDaTask("t")).rejects.toThrow(`clickup_comments_http_${status}`);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
    const dormir = vi.fn(async () => undefined);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(resposta({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(resposta({ comments: [] }));
    const cliente = new ClienteDeComentariosClickUp({
      token: "x",
      fetchImpl: fetchImpl as typeof fetch,
      dormir,
    });
    await cliente.listarDaTask("t");
    expect(dormir).toHaveBeenCalledWith(2_000);
  });
});
