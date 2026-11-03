import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalizeClickUpManifest, discoveredObjectToStaging } from "@/lib/clickup/manifest";

// O script é JavaScript intencionalmente executável fora do bundle Next.
import { exportarClickUpV3 } from "./clickup-export-v3.mjs";

const temporarios: string[] = [];
async function destino() {
  const pasta = await mkdtemp(join(tmpdir(), "clickup-v3-"));
  temporarios.push(pasta);
  return join(pasta, "manifest.json");
}

function resposta(valor: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(valor), { status, headers });
}

describe("exportador ClickUp v3", () => {
  afterEach(() => vi.restoreAllMocks());

  it("snapshot metadata-only de 50 Docs preserva inventário e bloqueia conteúdo", async () => {
    const out = await destino();
    const fetchImpl = vi.fn(async () =>
      resposta({
        docs: Array.from({ length: 50 }, (_, indice) => ({
          id: `d${indice}`,
          name: `Doc ${indice}`,
        })),
        next_cursor: null,
      }),
    );
    const resultado = await exportarClickUpV3(
      {
        token: "segredo",
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
        metadataOnly: true,
      },
      { fetchImpl, dormir: async () => undefined },
    );
    expect(resultado.inventory).toBe(50);
    expect(resultado.manifest.objects).toHaveLength(50);
    expect(
      resultado.manifest.objects.every((objeto) => objeto.content_access === "metadata_only"),
    ).toBe(true);
    expect(resultado.manifest.objects.every((objeto) => !("payload" in objeto))).toBe(true);
    expect(await readFile(out, "utf8")).not.toContain("segredo");
    const staged = canonicalizeClickUpManifest(resultado.manifest).objects.map((objeto) =>
      discoveredObjectToStaging(objeto),
    );
    expect(staged).toHaveLength(50);
    expect(staged.filter((item) => !item.execution_blocked)).toHaveLength(0);
    expect(new Set(staged.map((item) => item.blocked_reason))).toEqual(
      new Set(["clickup_doc_content_not_authorized"]),
    );
  });

  it("retoma checkpoint sem repetir Docs já materializados", async () => {
    const out = await destino();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/docs?"))
        return resposta({ docs: [{ id: "d1", name: "Manual" }], next_cursor: null });
      if (url.endsWith("/pages?max_page_depth=-1&content_format=text%2Fmd")) {
        return resposta({ pages: [{ id: "p1", name: "Início" }] });
      }
      return resposta({ id: "p1", name: "Início", content: "Conteúdo" });
    });
    const opcoes = {
      token: "segredo",
      workspaceId: "wk",
      connectionId: "00000000-0000-4000-8000-000000000001",
      out,
    };
    const primeira = await exportarClickUpV3(opcoes, { fetchImpl, dormir: async () => undefined });
    const chamadas = fetchImpl.mock.calls.length;
    const segunda = await exportarClickUpV3(
      { ...opcoes, resume: true },
      { fetchImpl, dormir: async () => undefined },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(chamadas);
    expect(segunda.manifest).toEqual(primeira.manifest);
  });

  it("sem --resume busca snapshot novo mesmo com checkpoint finalizado", async () => {
    const out = await destino();
    let rodada = 0;
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/docs?")) {
        rodada += 1;
        return resposta({ docs: [{ id: "d1", name: "Manual", revision: `r${rodada}` }] });
      }
      if (url.includes("/pages?")) return resposta({ pages: [{ id: "p1" }] });
      return resposta({ id: "p1", content: `Conteúdo ${rodada}` });
    });
    const opcoes = {
      token: "segredo",
      workspaceId: "wk",
      connectionId: "00000000-0000-4000-8000-000000000001",
      out,
    };
    const primeira = await exportarClickUpV3(opcoes, { fetchImpl, dormir: async () => undefined });
    const segunda = await exportarClickUpV3(opcoes, { fetchImpl, dormir: async () => undefined });
    expect(rodada).toBe(2);
    expect(segunda.manifest.objects[0]?.payload).not.toEqual(primeira.manifest.objects[0]?.payload);
  });

  it("não persiste signed URL e marca anexo como não importado", async () => {
    const out = await destino();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/docs?")) return resposta({ docs: [{ id: "d1", name: "Manual" }] });
      if (url.includes("/pages?")) return resposta({ pages: [{ id: "p1" }] });
      return resposta({
        id: "p1",
        content: "Texto",
        attachments: [{ id: "a1", url: "https://attachments.clickup.com/a?token=secreto" }],
      });
    });
    const resultado = await exportarClickUpV3(
      {
        token: "api-secreta",
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
      },
      { fetchImpl, dormir: async () => undefined },
    );
    const serializado = JSON.stringify(resultado.manifest);
    expect(serializado).not.toContain("token=secreto");
    expect(serializado).not.toContain("api-secreta");
    expect(resultado.manifest.objects[0]?.metadata).toMatchObject({
      attachment_import_status: "skipped_not_imported",
      attachments_skipped_count: 1,
      page_ids: ["p1"],
      attachment_manifest: [expect.objectContaining({ import_status: "skipped_not_imported" })],
    });
  });

  it("não repete 401 e respeita Retry-After do 429", async () => {
    const out401 = await destino();
    const fetch401 = vi.fn(async () => resposta({}, 401));
    await expect(
      exportarClickUpV3(
        {
          token: "segredo",
          workspaceId: "wk",
          connectionId: "00000000-0000-4000-8000-000000000001",
          out: out401,
          metadataOnly: true,
        },
        { fetchImpl: fetch401, dormir: async () => undefined },
      ),
    ).rejects.toThrow("clickup_v3_http_401");
    expect(fetch401).toHaveBeenCalledTimes(1);

    const out429 = await destino();
    const dormir = vi.fn(async () => undefined);
    const fetch429 = vi
      .fn()
      .mockResolvedValueOnce(resposta({}, 429, { "retry-after": "3" }))
      .mockResolvedValueOnce(resposta({ docs: [], next_cursor: null }));
    await exportarClickUpV3(
      {
        token: "segredo",
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out: out429,
        metadataOnly: true,
      },
      { fetchImpl: fetch429, dormir },
    );
    expect(dormir).toHaveBeenCalledWith(3_000);
  });
});
