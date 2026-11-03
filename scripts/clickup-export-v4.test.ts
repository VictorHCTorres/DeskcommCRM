import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { clickupSidecarSchema } from "@/lib/clickup/sidecar-contrato";
import { coverageCompletaClickUpV4 } from "@/lib/clickup/comments/coverage";

import { exportarClickUpV4 } from "./clickup-export-v4.mjs";

const RUN_ID = "00000000-0000-4000-8000-000000000099";
const SNAPSHOT_HASH = "9".repeat(64);
const VINCULO_STAGE = { runId: RUN_ID, snapshotHash: SNAPSHOT_HASH };

const resposta = (valor: unknown) =>
  new Response(JSON.stringify(valor), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function ambiente(taskIds: string[]) {
  const pasta = await mkdtemp(join(tmpdir(), "clickup-v4-"));
  const tasks = join(pasta, "tasks.json");
  const out = join(pasta, "package.json");
  await writeFile(tasks, JSON.stringify(taskIds));
  return { pasta, tasks, out };
}

async function manifestoDocs(pasta: string, objects: unknown[] = []) {
  const path = join(pasta, "docs-manifest.json");
  await writeFile(path, JSON.stringify({ manifest_version: 3, workspace_id: "wk", objects }));
  return path;
}

function comentario(indice: number, extras: Record<string, unknown> = {}) {
  return {
    id: `c${String(indice).padStart(2, "0")}`,
    date: String(1_730_619_000_000 - indice),
    comment_text: `Comentário ${indice}`,
    user: { id: 1, username: "Autor" },
    ...extras,
  };
}

describe("exportador ClickUp v4", () => {
  it("pagina >25 por start+start_id, inclui replies e não persiste token/URL", async () => {
    const { tasks, out } = await ambiente(["t1"]);
    const urls: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/attachments/")) {
        return resposta({
          attachments: [{ id: "a1", name: "x.pdf", size: 10, url: "https://signed/secret" }],
        });
      }
      if (url.includes("/comment/c05/reply"))
        return resposta({ comments: [comentario(100, { id: "r1" })] });
      if (url.includes("start_id=")) return resposta({ comments: [comentario(26)] });
      return resposta({
        comments: Array.from({ length: 25 }, (_, indice) =>
          comentario(
            indice + 1,
            indice === 4
              ? { reply_count: 1 }
              : indice === 0
                ? { attachments: [{ id: "a1", url: "https://signed/ignored" }] }
                : {},
          ),
        ),
      });
    });
    const pacote = await exportarClickUpV4(
      {
        token: "token-secreto",
        tasks,
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
        mode: "inventory",
        tasksExpected: 1,
        ...VINCULO_STAGE,
      },
      {
        fetchImpl,
        dormir: async () => undefined,
        gravarCheckpointTask: async () => undefined,
      },
    );
    expect(
      urls.some((url) => url.includes("start=1730618999975") && url.includes("start_id=c25")),
    ).toBe(true);
    expect(pacote.coverage).toMatchObject({
      tasks_comments_scanned: 1,
      comments_found: 27,
      replies_found: 1,
      assets_found: 1,
    });
    expect(pacote.assets[0]).toMatchObject({ attachment_id: "a1", comment_id: "c01" });
    expect(clickupSidecarSchema.safeParse(pacote).success).toBe(true);
    const pai = pacote.comments.findIndex(
      (item: { comment_id: string }) => item.comment_id === "c05",
    );
    const reply = pacote.comments.findIndex(
      (item: { comment_id: string }) => item.comment_id === "r1",
    );
    expect(reply).toBeGreaterThan(pai);
    const persistido = await readFile(out, "utf8");
    expect(persistido).not.toContain("token-secreto");
    expect(persistido).not.toContain("https://signed");
  });

  it("só declara coverage completa quando as 1.983 Tasks chegam ao cursor terminal", async () => {
    const ids = Array.from({ length: 1_983 }, (_, indice) => `t${indice}`);
    const { tasks, out } = await ambiente(ids);
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      resposta(String(input).includes("/attachments/") ? { attachments: [] } : { comments: [] }),
    );
    const pacote = await exportarClickUpV4(
      {
        token: "token",
        tasks,
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
        mode: "inventory",
        tasksExpected: 1_983,
        ...VINCULO_STAGE,
      },
      {
        fetchImpl,
        dormir: async () => undefined,
        gravarCheckpointTask: async () => undefined,
      },
    );
    expect(pacote.coverage.tasks_expected).toBe(1_983);
    expect(pacote.coverage.tasks_comments_scanned).toBe(1_983);
    expect(pacote.coverage.attachment_parents_scanned).toBe(1_983);
    expect(coverageCompletaClickUpV4(pacote.coverage)).toBe(true);
    expect(clickupSidecarSchema.safeParse(pacote).success).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(3_966);
  }, 30_000);

  it("checkpoint só é consumido com resume explícito", async () => {
    const { tasks, out } = await ambiente(["t1"]);
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      resposta(String(input).includes("/attachments/") ? { attachments: [] } : { comments: [] }),
    );
    const opcoes = {
      token: "token",
      tasks,
      workspaceId: "wk",
      connectionId: "00000000-0000-4000-8000-000000000001",
      out,
      mode: "inventory",
      tasksExpected: 1,
      ...VINCULO_STAGE,
    };
    await exportarClickUpV4(opcoes, { fetchImpl, dormir: async () => undefined });
    const chamadas = fetchImpl.mock.calls.length;
    await exportarClickUpV4(
      { ...opcoes, resume: true },
      { fetchImpl, dormir: async () => undefined },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(chamadas);
    await exportarClickUpV4(opcoes, { fetchImpl, dormir: async () => undefined });
    expect(fetchImpl).toHaveBeenCalledTimes(chamadas * 2);
  });

  it("materializa assets full por hash sem persistir a URL de origem", async () => {
    const { pasta, tasks, out } = await ambiente(["t1"]);
    const docsManifest = await manifestoDocs(pasta);
    const processAsset = vi.fn(async () => ({
      sniffed_mime: "application/pdf",
      sha256: "a".repeat(64),
      blob_ref: `blobs/${"a".repeat(64)}.pdf`,
      bytes_downloaded: 12,
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      resposta(
        String(input).includes("/attachments/")
          ? {
              attachments: [
                {
                  id: "a1",
                  name: "manual.pdf",
                  size: 999,
                  url: "https://attachments.clickup.com/signed-secret",
                },
              ],
            }
          : { comments: [] },
      ),
    );
    const pacote = await exportarClickUpV4(
      {
        token: "token",
        tasks,
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
        mode: "full",
        tasksExpected: 1,
        docsManifest,
        ...VINCULO_STAGE,
      },
      { fetchImpl, processAsset, dormir: async () => undefined },
    );
    expect(pacote.coverage.bytes_downloaded).toBe(12);
    expect(pacote.assets[0]).toMatchObject({
      sniffed_mime: "application/pdf",
      sha256: "a".repeat(64),
      declared_size: 12,
    });
    expect(clickupSidecarSchema.safeParse(pacote).success).toBe(true);
    expect(pacote).toMatchObject({ run_id: RUN_ID, snapshot_hash: SNAPSHOT_HASH });
    expect(await readFile(out, "utf8")).not.toContain("signed-secret");
  });

  it("revarre doc pages, materializa assets e prova cursor terminal da página", async () => {
    const { pasta, tasks, out } = await ambiente(["t1"]);
    const docsManifest = await manifestoDocs(pasta, [
      {
        source_type: "doc",
        source_id: "d1",
        metadata: { private: false, page_ids: ["p1"] },
      },
    ]);
    const processAsset = vi.fn(async () => ({
      sniffed_mime: "application/pdf",
      sha256: "b".repeat(64),
      blob_ref: `blobs/${"b".repeat(64)}.pdf`,
      bytes_downloaded: 9,
    }));
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/docs/d1/pages/p1")) {
        return resposta({
          id: "p1",
          attachments: [
            {
              id: "doc-a1",
              name: "doc.pdf",
              download_url: "https://attachments.clickup.com/temporary",
            },
          ],
        });
      }
      if (url.includes("/docs/d1/pages?")) return resposta({ pages: [{ id: "p1" }] });
      return resposta(url.includes("/attachments/") ? { attachments: [] } : { comments: [] });
    });
    const pacote = await exportarClickUpV4(
      {
        token: "token",
        tasks,
        docsManifest,
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
        mode: "full",
        tasksExpected: 1,
        ...VINCULO_STAGE,
      },
      { fetchImpl, processAsset, dormir: async () => undefined },
    );
    expect(pacote.assets).toContainEqual(
      expect.objectContaining({
        attachment_id: "doc-a1",
        parent_type: "doc_page",
        parent_external_id: "p1",
        declared_size: 9,
      }),
    );
    expect(pacote.coverage.terminal_cursors).toContainEqual({
      kind: "doc_pages",
      parent_external_id: "p1",
      cursor: null,
      terminal: true,
    });
    expect(pacote.coverage.attachment_parents_scanned).toBe(2);
    expect(clickupSidecarSchema.safeParse(pacote).success).toBe(true);
  });

  it("recusa replies truncadas e full sem cobertura integral", async () => {
    const { pasta, tasks, out } = await ambiente(["t1"]);
    const docsManifest = await manifestoDocs(pasta);
    const repliesTruncadas = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/comment/c01/reply")) return resposta({ comments: [comentario(9)] });
      if (url.includes("/attachments/")) return resposta({ attachments: [] });
      return resposta({ comments: [comentario(1, { reply_count: 2 })] });
    });
    await expect(
      exportarClickUpV4(
        {
          token: "token",
          tasks,
          docsManifest,
          workspaceId: "wk",
          connectionId: "00000000-0000-4000-8000-000000000001",
          out,
          mode: "full",
          tasksExpected: 1,
          ...VINCULO_STAGE,
        },
        { fetchImpl: repliesTruncadas, dormir: async () => undefined },
      ),
    ).rejects.toThrow("clickup_replies_incomplete");

    const fetchVazio = vi.fn(async (input: string | URL | Request) =>
      resposta(String(input).includes("/attachments/") ? { attachments: [] } : { comments: [] }),
    );
    await expect(
      exportarClickUpV4(
        {
          token: "token",
          tasks,
          docsManifest,
          workspaceId: "wk",
          connectionId: "00000000-0000-4000-8000-000000000001",
          out,
          mode: "full",
          tasksExpected: 2,
          ...VINCULO_STAGE,
        },
        { fetchImpl: fetchVazio, dormir: async () => undefined },
      ),
    ).rejects.toThrow("clickup_v4_full_coverage_incomplete");
  });

  it("recusa blob vazio e exige consentimento explícito para Docs privados", async () => {
    const { pasta, tasks, out } = await ambiente(["t1"]);
    const docsManifest = await manifestoDocs(pasta);
    const fetchImpl = vi.fn(async (input: string | URL | Request) =>
      resposta(
        String(input).includes("/attachments/")
          ? {
              attachments: [
                { id: "empty", name: "empty.txt", url: "https://attachments.clickup.com/empty" },
              ],
            }
          : { comments: [] },
      ),
    );
    const pacote = await exportarClickUpV4(
      {
        token: "token",
        tasks,
        docsManifest,
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
        mode: "full",
        tasksExpected: 1,
        ...VINCULO_STAGE,
      },
      {
        fetchImpl,
        dormir: async () => undefined,
        processAsset: async () => ({
          sniffed_mime: "text/plain",
          sha256: "0".repeat(64),
          blob_ref: `blobs/${"0".repeat(64)}.txt`,
          bytes_downloaded: 0,
        }),
      },
    );
    expect(pacote.assets).toEqual([]);
    expect(pacote.coverage.skips).toContainEqual({ reason: "skipped_asset_empty", count: 1 });

    const privateManifest = await manifestoDocs(pasta, [
      {
        source_type: "doc",
        source_id: "private-doc",
        metadata: { private: true, private_scope_explicit: true, page_ids: [] },
      },
    ]);
    await expect(
      exportarClickUpV4({
        token: "token",
        tasks,
        docsManifest: privateManifest,
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
        mode: "inventory",
        tasksExpected: 1,
        ...VINCULO_STAGE,
      }),
    ).rejects.toThrow("clickup_v4_private_docs_require_explicit_consent");
  });

  it("recusa omissão ou página extra frente aos page_ids staged", async () => {
    const { pasta, tasks, out } = await ambiente(["t1"]);
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("/docs/d1/pages?")) return resposta({ pages: [{ id: "p1" }] });
      if (url.includes("/docs/d1/pages/p1")) return resposta({ id: "p1", attachments: [] });
      return resposta(url.includes("/attachments/") ? { attachments: [] } : { comments: [] });
    });
    const executar = async (pageIds: string[]) => {
      const docsManifest = await manifestoDocs(pasta, [
        {
          source_type: "doc",
          source_id: "d1",
          metadata: { private: false, page_ids: pageIds },
        },
      ]);
      return exportarClickUpV4(
        {
          token: "token",
          tasks,
          docsManifest,
          workspaceId: "wk",
          connectionId: "00000000-0000-4000-8000-000000000001",
          out,
          mode: "full",
          tasksExpected: 1,
          ...VINCULO_STAGE,
        },
        { fetchImpl, dormir: async () => undefined },
      );
    };
    await expect(executar(["p1", "p2"])).rejects.toThrow("clickup_v4_doc_pages_coverage_mismatch");
    await expect(executar([])).rejects.toThrow("clickup_v4_doc_pages_coverage_mismatch");
  });

  it("exige o run e snapshot reais antes de produzir um artefato stageável", async () => {
    const { tasks, out } = await ambiente([]);
    await expect(
      exportarClickUpV4({
        token: "token",
        tasks,
        workspaceId: "wk",
        connectionId: "00000000-0000-4000-8000-000000000001",
        out,
        mode: "inventory",
        tasksExpected: 0,
      }),
    ).rejects.toThrow("clickup_v4_options_missing");
  });
});
