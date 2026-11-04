import { describe, expect, it, vi } from "vitest";

import { ClienteLiveSidecarClickUp } from "./cliente";

const response = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });

describe("cliente live sidecar ClickUp", () => {
  it("pagina assets, mantém URL só no retorno transitório e nunca a envia na URL da API", async () => {
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      return url.includes("cursor=next")
        ? response({ attachments: [{ id: "a2", name: "b.pdf", size: 2 }] })
        : response({
            attachments: [
              { id: "a1", name: "a.pdf", url: "https://clickup.com/x?sig=secret", size: 1 },
            ],
            next_cursor: "next",
          });
    });
    const client = new ClienteLiveSidecarClickUp({
      token: "token-secret",
      fetchImpl: fetchImpl as typeof fetch,
    });
    const assets = await client.listarAssetsDaTask("workspace", "task");
    expect(assets.map((item) => item.attachmentId)).toEqual(["a1", "a2"]);
    expect(assets[0]?.sourceUrl).toContain("sig=secret");
    expect(urls.join(" ")).not.toContain("token-secret");
  });

  it("repete 429 com espera limitada e não repete 403", async () => {
    const dormir = vi.fn(async () => undefined);
    const retry = vi
      .fn()
      .mockResolvedValueOnce(response({}, 429, { "retry-after": "999" }))
      .mockResolvedValueOnce(response({ attachments: [] }));
    await new ClienteLiveSidecarClickUp({
      token: "x",
      fetchImpl: retry as typeof fetch,
      dormir,
    }).listarAssetsDaTask("w", "t");
    expect(dormir).toHaveBeenCalledWith(5_000);
    const forbidden = vi.fn(async () => response({}, 403));
    await expect(
      new ClienteLiveSidecarClickUp({
        token: "x",
        fetchImpl: forbidden as typeof fetch,
      }).listarAssetsDaTask("w", "t"),
    ).rejects.toThrow("clickup_assets_http_403");
    expect(forbidden).toHaveBeenCalledOnce();
  });
});
