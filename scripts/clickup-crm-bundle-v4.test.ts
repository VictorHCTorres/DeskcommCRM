import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { clickupSidecarSchema } from "@/lib/clickup/sidecar-contrato";

import { exportarClickUpCrmBundleV4 } from "./clickup-crm-bundle-v4.mjs";

const RUN_ID = "00000000-0000-4000-8000-000000000099";

async function backupLegado() {
  const root = await mkdtemp(join(tmpdir(), "clickup-bundle-v4-"));
  await mkdir(join(root, "tasks"));
  await mkdir(join(root, "campos"));
  await writeFile(
    join(root, "hierarquia.json"),
    JSON.stringify({
      team: "wk",
      spaces: [
        { id: "s", name: "Área", folders: [], lists: [{ id: "l", name: "Lista", statuses: [] }] },
      ],
    }),
  );
  await writeFile(join(root, "campos/l.json"), JSON.stringify({ fields: [] }));
  await writeFile(join(root, "tasks/l.jsonl"), `${JSON.stringify({ id: "t1", name: "Task" })}\n`);
  return root;
}

describe("bundle CRM v4", () => {
  it("não interpreta ausência no backup legado como zero", async () => {
    const backup = await backupLegado();
    const pacote = await exportarClickUpCrmBundleV4({
      backup,
      connectionId: "00000000-0000-4000-8000-000000000001",
      runId: RUN_ID,
    });
    expect(pacote.manifest.manifest_version).toBe(3);
    expect(pacote.sidecar.coverage).toMatchObject({
      tasks_expected: 1_983,
      tasks_comments_scanned: 0,
      skips: [{ reason: "unknown_not_exported", count: 1_983 }],
    });
    expect(clickupSidecarSchema.safeParse(pacote.sidecar).success).toBe(true);
    expect(pacote.sidecar.run_id).toBe(RUN_ID);
  });

  it("recusa sidecar que contenha URL assinada", async () => {
    const backup = await backupLegado();
    const sidecar = join(backup, "sidecar.json");
    await writeFile(
      sidecar,
      JSON.stringify({
        workspace_id: "wk",
        manifest_version: 3,
        source: "https://clickup.com/a?token=segredo",
      }),
    );
    await expect(
      exportarClickUpCrmBundleV4({
        backup,
        sidecar,
        connectionId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("clickup_v4_sidecar_contains_secret");
  });

  it("não inventa run_id para fallback legado", async () => {
    const backup = await backupLegado();
    await expect(
      exportarClickUpCrmBundleV4({
        backup,
        connectionId: "00000000-0000-4000-8000-000000000001",
      }),
    ).rejects.toThrow("clickup_v4_real_run_id_required");
  });
});
