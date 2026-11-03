#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API = "https://api.clickup.com/api/v3";

function canonico(valor) {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  return `{${Object.keys(valor)
    .sort()
    .map((chave) => `${JSON.stringify(chave)}:${canonico(valor[chave])}`)
    .join(",")}}`;
}

function hash(valor) {
  return createHash("sha256")
    .update(typeof valor === "string" ? valor : canonico(valor))
    .digest("hex");
}

async function gravarAtomico(caminho, valor) {
  await mkdir(dirname(caminho), { recursive: true });
  const temporario = `${caminho}.${process.pid}.tmp`;
  await writeFile(temporario, `${JSON.stringify(valor, null, 2)}\n`, { mode: 0o600 });
  await rename(temporario, caminho);
}

async function lerJson(caminho, fallback) {
  try {
    return JSON.parse(await readFile(caminho, "utf8"));
  } catch (erro) {
    if (erro && typeof erro === "object" && erro.code === "ENOENT") return fallback;
    throw erro;
  }
}

function argsDaCli(argv) {
  const args = { includePrivate: false, metadataOnly: false, resume: false };
  for (let i = 0; i < argv.length; i += 1) {
    const atual = argv[i];
    if (atual === "--include-private") args.includePrivate = true;
    else if (atual === "--metadata-only") args.metadataOnly = true;
    else if (atual === "--resume") args.resume = true;
    else if (atual === "--workspace") args.workspaceId = argv[++i];
    else if (atual === "--connection-id") args.connectionId = argv[++i];
    else if (atual === "--out") args.out = argv[++i];
    else if (atual === "--checkpoint") args.checkpoint = argv[++i];
    else throw new Error(`argumento_desconhecido:${atual}`);
  }
  return args;
}

function registro(valor) {
  return valor && typeof valor === "object" && !Array.isArray(valor) ? valor : {};
}

function lista(valor) {
  return Array.isArray(valor) ? valor : [];
}

function texto(valor, fallback = "") {
  return typeof valor === "string" || typeof valor === "number" ? String(valor) : fallback;
}

function docNormalizado(valor) {
  const raw = registro(valor);
  const id = texto(raw.id ?? raw.doc_id);
  if (!id) return null;
  const visibility = texto(
    raw.visibility ?? raw.access ?? raw.permission_level,
    "PUBLIC",
  ).toUpperCase();
  return {
    id,
    name: texto(raw.name ?? raw.title, `Doc ${id}`),
    visibility,
    private: raw.private === true || visibility === "PRIVATE" || visibility === "RESTRICTED",
    revision: texto(raw.updated_at ?? raw.date_updated ?? raw.revision) || null,
  };
}

function achatarPaginas(valor) {
  const raw = registro(valor);
  const resultado = [];
  const visitar = (itens) => {
    for (const item of itens) {
      const pagina = registro(item);
      if (texto(pagina.id ?? pagina.page_id)) resultado.push(pagina);
      visitar(lista(pagina.pages ?? pagina.children ?? pagina.subpages));
    }
  };
  visitar(lista(raw.pages ?? raw.data ?? valor));
  return resultado;
}

function normalizarMarkdown(valor) {
  return texto(valor)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((linha) => linha.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function requisitar(fetchImpl, token, path, dormir) {
  for (let tentativa = 0; tentativa < 4; tentativa += 1) {
    const resposta = await fetchImpl(`${API}${path}`, {
      headers: { Authorization: token, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (resposta.ok) return resposta.json();
    if ((resposta.status === 429 || resposta.status >= 500) && tentativa < 3) {
      const retryAfter = Number(resposta.headers.get("retry-after") ?? 0);
      await dormir(retryAfter > 0 ? retryAfter * 1000 : 250 * 2 ** tentativa);
      continue;
    }
    throw new Error(`clickup_v3_http_${resposta.status}`);
  }
  throw new Error("clickup_v3_retry_exhausted");
}

export async function exportarClickUpV3(opcoes, deps = {}) {
  const token = opcoes.token?.trim();
  if (!token) throw new Error("CLICKUP_API_TOKEN_ausente");
  if (!opcoes.workspaceId || !opcoes.connectionId)
    throw new Error("workspace_e_connection_obrigatorios");
  const out = resolve(opcoes.out ?? "clickup-export-v3/manifest.json");
  const checkpointPath = resolve(opcoes.checkpoint ?? `${out}.checkpoint.json`);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const dormir =
    deps.dormir ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  const estadoInicial = {
    schema_version: 3,
    workspace_id: opcoes.workspaceId,
    export_mode: {
      include_private: Boolean(opcoes.includePrivate),
      metadata_only: Boolean(opcoes.metadataOnly),
    },
    cursor: null,
    inventory_complete: false,
    docs: [],
    objects: {},
  };
  const estado = opcoes.resume ? await lerJson(checkpointPath, estadoInicial) : estadoInicial;
  if (
    estado.workspace_id !== opcoes.workspaceId ||
    estado.schema_version !== 3 ||
    estado.export_mode?.include_private !== Boolean(opcoes.includePrivate) ||
    estado.export_mode?.metadata_only !== Boolean(opcoes.metadataOnly)
  ) {
    throw new Error("checkpoint_incompativel");
  }

  if (!estado.inventory_complete) {
    let cursor = estado.cursor;
    const cursoresVisitados = new Set(cursor ? [cursor] : []);
    do {
      const params = new URLSearchParams({ deleted: "false", archived: "false", limit: "50" });
      if (cursor) params.set("cursor", cursor);
      const pagina = registro(
        await requisitar(
          fetchImpl,
          token,
          `/workspaces/${encodeURIComponent(opcoes.workspaceId)}/docs?${params}`,
          dormir,
        ),
      );
      for (const bruto of lista(pagina.docs ?? pagina.data ?? pagina.results)) {
        const doc = docNormalizado(bruto);
        if (doc && !estado.docs.some((existente) => existente.id === doc.id)) estado.docs.push(doc);
      }
      const proximoCursor = texto(pagina.next_cursor ?? registro(pagina.meta).next_cursor) || null;
      if (proximoCursor && cursoresVisitados.has(proximoCursor)) {
        throw new Error("clickup_v3_cursor_cycle");
      }
      cursor = proximoCursor;
      if (cursor) cursoresVisitados.add(cursor);
      estado.cursor = cursor;
      estado.inventory_complete = cursor === null;
      await gravarAtomico(checkpointPath, estado);
    } while (cursor);
  }

  const elegiveis = estado.docs.filter((doc) => opcoes.includePrivate || !doc.private);
  for (const doc of elegiveis) {
    if (estado.objects[doc.id]) continue;
    if (opcoes.metadataOnly) {
      estado.objects[doc.id] = {
        source_type: "doc",
        source_id: doc.id,
        source_revision: doc.revision,
        metadata: {
          name: doc.name,
          visibility: doc.visibility,
          private: doc.private,
          attachment_manifest: [],
        },
        content_access: "metadata_only",
      };
      await gravarAtomico(checkpointPath, estado);
      continue;
    }
    const base = `/workspaces/${encodeURIComponent(opcoes.workspaceId)}/docs/${encodeURIComponent(doc.id)}/pages`;
    const estrutura = await requisitar(
      fetchImpl,
      token,
      `${base}?max_page_depth=-1&content_format=text%2Fmd`,
      dormir,
    );
    const secoes = [];
    const anexos = [];
    for (const resumo of achatarPaginas(estrutura)) {
      const pageId = texto(resumo.id ?? resumo.page_id);
      const pagina = registro(
        await requisitar(
          fetchImpl,
          token,
          `${base}/${encodeURIComponent(pageId)}?content_format=text%2Fmd`,
          dormir,
        ),
      );
      const titulo = texto(
        pagina.name ?? pagina.title ?? resumo.name ?? resumo.title,
        `Página ${pageId}`,
      );
      secoes.push(`# ${titulo}\n\n${normalizarMarkdown(pagina.content ?? pagina.markdown)}`.trim());
      for (const bruto of lista(pagina.attachments ?? registro(pagina.content).attachments)) {
        const anexo = registro(bruto);
        const id = texto(anexo.id ?? anexo.attachment_id);
        if (!id) continue;
        anexos.push({
          id,
          page_id: pageId,
          name: texto(anexo.name ?? anexo.filename, `anexo-${id}`),
          size_bytes: Number.isFinite(Number(anexo.size ?? anexo.size_bytes))
            ? Number(anexo.size ?? anexo.size_bytes)
            : null,
          mime_type: texto(anexo.mime_type ?? anexo.content_type) || null,
          source_url_present: Boolean(texto(anexo.download_url ?? anexo.url)),
          import_status: "skipped_not_imported",
          warning: "attachment_transport_not_available_in_manifest_v3",
        });
      }
    }
    const content = secoes.join("\n\n").trim();
    if (!content) throw new Error(`doc_sem_conteudo:${doc.id}`);
    estado.objects[doc.id] = {
      source_type: "doc",
      source_id: doc.id,
      source_revision: doc.revision ?? hash(content),
      metadata: {
        name: doc.name,
        visibility: doc.visibility,
        private: doc.private,
        private_scope_explicit: doc.private && opcoes.includePrivate,
        content_sha256: hash(content),
        attachment_manifest: anexos.sort(
          (a, b) => a.page_id.localeCompare(b.page_id) || a.id.localeCompare(b.id),
        ),
        attachment_import_status: anexos.length ? "skipped_not_imported" : "none",
        attachments_skipped_count: anexos.length,
        attachment_warnings: anexos.map((anexo) => ({
          attachment_id: anexo.id,
          page_id: anexo.page_id,
          code: anexo.warning,
        })),
      },
      payload: { format: "markdown", content },
      content_access: "full",
    };
    await gravarAtomico(checkpointPath, estado);
  }

  const manifest = {
    connection_id: opcoes.connectionId,
    workspace_id: opcoes.workspaceId,
    source: "bundle",
    scope: "docs",
    manifest_version: 3,
    source_revision: hash(estado.docs.map(({ id, revision }) => ({ id, revision }))),
    objects: Object.values(estado.objects).sort((a, b) => a.source_id.localeCompare(b.source_id)),
  };
  await gravarAtomico(out, manifest);
  estado.finalized_at = new Date().toISOString();
  await gravarAtomico(checkpointPath, estado);
  return { manifest, output: out, checkpoint: checkpointPath, inventory: estado.docs.length };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = argsDaCli(argv);
  if (args.includePrivate) {
    (deps.stderr ?? process.stderr).write(
      "AVISO: Docs privados/restritos entram no Knowledge da organização inteira; a importação exige admin.\n",
    );
  }
  const resultado = await exportarClickUpV3(
    {
      ...args,
      token: deps.token ?? process.env.CLICKUP_API_TOKEN,
      workspaceId: args.workspaceId ?? process.env.CLICKUP_WORKSPACE_ID,
      connectionId: args.connectionId ?? process.env.CLICKUP_CONNECTION_ID,
    },
    deps,
  );
  (deps.stdout ?? process.stdout).write(
    `ClickUp v3: inventory=${resultado.inventory} exported=${resultado.manifest.objects.length} manifest_version=3\n`,
  );
  return resultado;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((erro) => {
    process.stderr.write(
      `Falha no export ClickUp v3: ${erro instanceof Error ? erro.message : "erro_desconhecido"}\n`,
    );
    process.exitCode = 1;
  });
}
