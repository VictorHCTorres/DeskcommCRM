#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { exportarClickUpCrmBundleV3 } from "./clickup-crm-bundle-v3.mjs";

const canonico = (valor) => {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  return `{${Object.keys(valor)
    .sort()
    .map((chave) => `${JSON.stringify(chave)}:${canonico(valor[chave])}`)
    .join(",")}}`;
};
const hash = (valor) => createHash("sha256").update(canonico(valor)).digest("hex");
const SEGREDO_OU_URL_ASSINADA =
  /(?:x-amz-(?:signature|credential)|[?&](?:token|sig|signature)=|pk_[a-z0-9_-]{20,}|authorization:\s*bearer)/i;

function argumentos(argv) {
  const resultado = {};
  for (let indice = 0; indice < argv.length; indice += 1) {
    const atual = argv[indice];
    if (atual === "--backup") resultado.backup = argv[++indice];
    else if (atual === "--connection-id") resultado.connectionId = argv[++indice];
    else if (atual === "--workspace") resultado.workspaceId = argv[++indice];
    else if (atual === "--sidecar") resultado.sidecar = argv[++indice];
    else if (atual === "--run-id") resultado.runId = argv[++indice];
    else if (atual === "--out") resultado.out = argv[++indice];
    else throw new Error(`argumento_desconhecido:${atual}`);
  }
  return resultado;
}

function sidecarLegado(workspaceId, tasksExpected, runId, snapshotHash) {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId ?? "")
  ) {
    throw new Error("clickup_v4_real_run_id_required");
  }
  const coverage = {
    tasks_expected: tasksExpected,
    tasks_comments_scanned: 0,
    attachment_parents_scanned: 0,
    terminal_cursors: [{ kind: "tasks", parent_external_id: null, cursor: null, terminal: true }],
    comments_found: 0,
    replies_found: 0,
    assets_found: 0,
    bytes_declared: 0,
    bytes_downloaded: 0,
    warnings: [{ code: "legacy_snapshot_without_comments_or_attachments" }],
    skips: [{ reason: "unknown_not_exported", count: tasksExpected }],
  };
  return {
    sidecar_version: 1,
    manifest_version: 3,
    run_id: runId,
    workspace_id: workspaceId,
    snapshot_hash: snapshotHash,
    coverage,
    checkpoint: {
      parent_type: "task",
      parent_external_id: workspaceId,
      cursor: null,
      terminal: true,
    },
    mode: "inventory",
    assets: [],
    comments: [],
  };
}

async function gravarAtomico(caminho, valor) {
  await mkdir(dirname(caminho), { recursive: true });
  const temporario = `${caminho}.${process.pid}.tmp`;
  await writeFile(temporario, `${JSON.stringify(valor, null, 2)}\n`, { mode: 0o600 });
  await rename(temporario, caminho);
}

export async function exportarClickUpCrmBundleV4(opcoes) {
  const manifest = await exportarClickUpCrmBundleV3({
    backup: opcoes.backup,
    connectionId: opcoes.connectionId,
    workspaceId: opcoes.workspaceId,
  });
  const snapshotHash = hash(manifest);
  const sidecar = opcoes.sidecar
    ? JSON.parse(await readFile(resolve(opcoes.sidecar), "utf8"))
    : sidecarLegado(manifest.workspace_id, 1_983, opcoes.runId, snapshotHash);
  if (sidecar.workspace_id !== manifest.workspace_id || sidecar.manifest_version !== 3) {
    throw new Error("clickup_v4_sidecar_incompatible");
  }
  if (SEGREDO_OU_URL_ASSINADA.test(JSON.stringify(sidecar))) {
    throw new Error("clickup_v4_sidecar_contains_secret");
  }
  if (sidecar.snapshot_hash !== snapshotHash) {
    throw new Error("clickup_v4_sidecar_snapshot_mismatch");
  }
  const pacote = {
    bundle_version: 4,
    manifest,
    sidecar,
    bundle_hash: hash({ manifest, sidecar }),
  };
  if (opcoes.out) await gravarAtomico(resolve(opcoes.out), pacote);
  return pacote;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  exportarClickUpCrmBundleV4(argumentos(process.argv.slice(2))).catch((erro) => {
    process.stderr.write(
      `Falha no bundle ClickUp CRM v4: ${erro instanceof Error ? erro.message : "erro_desconhecido"}\n`,
    );
    process.exitCode = 1;
  });
}
