#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";

const API_V2 = "https://api.clickup.com/api/v2";
const API_V3 = "https://api.clickup.com/api/v3";
const TASKS_ESPERADAS = 1_983;
const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const MAX_ASSETS_PER_TARGET = 20;
const MAX_ASSET_BYTES_PER_TARGET = 50 * 1024 * 1024;
const HOSTS_DE_ASSET = ["clickup.com", "clickupusercontent.com", "clickupcdn.com"];

const registro = (valor) =>
  valor && typeof valor === "object" && !Array.isArray(valor) ? valor : {};
const lista = (valor) => (Array.isArray(valor) ? valor : []);
const texto = (valor) =>
  typeof valor === "string" || typeof valor === "number" ? String(valor) : "";
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

async function carregarTasksDoCheckpoint(checkpointDir, runId) {
  const pasta = resolve(checkpointDir, "tasks", runId);
  let arquivos;
  try {
    arquivos = await readdir(pasta);
  } catch (erro) {
    if (erro && typeof erro === "object" && erro.code === "ENOENT") return {};
    throw erro;
  }
  const tasks = {};
  for (const arquivo of arquivos.filter((nome) => nome.endsWith(".json")).sort()) {
    const item = await lerJson(resolve(pasta, arquivo), null);
    if (item?.task_id && item.result) tasks[item.task_id] = item.result;
  }
  return tasks;
}

async function gravarCheckpointDaTask(checkpointDir, runId, taskId, result) {
  const nome = `${createHash("sha256").update(taskId).digest("hex")}.json`;
  await gravarAtomico(resolve(checkpointDir, "tasks", runId, nome), {
    task_id: taskId,
    result,
  });
}

function argumentos(argv) {
  const resultado = { mode: "inventory", resume: false, tasksExpected: TASKS_ESPERADAS };
  for (let indice = 0; indice < argv.length; indice += 1) {
    const atual = argv[indice];
    if (atual === "--tasks") resultado.tasks = argv[++indice];
    else if (atual === "--docs-manifest") resultado.docsManifest = argv[++indice];
    else if (atual === "--workspace") resultado.workspaceId = argv[++indice];
    else if (atual === "--connection-id") resultado.connectionId = argv[++indice];
    else if (atual === "--out") resultado.out = argv[++indice];
    else if (atual === "--checkpoint") resultado.checkpoint = argv[++indice];
    else if (atual === "--run-id") resultado.runId = argv[++indice];
    else if (atual === "--snapshot-hash") resultado.snapshotHash = argv[++indice];
    else if (atual === "--mode") resultado.mode = argv[++indice];
    else if (atual === "--tasks-expected") resultado.tasksExpected = Number(argv[++indice]);
    else if (atual === "--resume") resultado.resume = true;
    else if (atual === "--include-private-docs") resultado.includePrivateDocs = true;
    else throw new Error(`argumento_desconhecido:${atual}`);
  }
  return resultado;
}

async function idsDasTasks(caminho) {
  const conteudo = await readFile(resolve(caminho), "utf8");
  let valores;
  try {
    valores = JSON.parse(conteudo);
  } catch {
    valores = conteudo
      .split(/\r?\n/)
      .filter(Boolean)
      .map((linha) => JSON.parse(linha));
  }
  const candidatos = Array.isArray(valores) ? valores : lista(registro(valores).tasks);
  return [
    ...new Set(candidatos.map((valor) => texto(registro(valor).id ?? valor)).filter(Boolean)),
  ].sort();
}

async function docsDoManifesto(caminho, workspaceId, includePrivateDocs) {
  const manifest = JSON.parse(await readFile(resolve(caminho), "utf8"));
  if (manifest.manifest_version !== 3 || manifest.workspace_id !== workspaceId) {
    throw new Error("clickup_v4_docs_manifest_incompatible");
  }
  const docs = lista(manifest.objects)
    .map(registro)
    .filter((item) => item.source_type === "doc")
    .map((item) => {
      const metadata = registro(item.metadata);
      if (!Array.isArray(metadata.page_ids)) {
        throw new Error("clickup_v4_docs_manifest_missing_page_ids");
      }
      return {
        id: texto(item.source_id),
        private: Boolean(metadata.private),
        privateExplicit: Boolean(metadata.private_scope_explicit),
        pageIds: [...new Set(metadata.page_ids.map(texto).filter(Boolean))].sort(),
      };
    })
    .filter((item) => item.id)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (docs.some((doc) => doc.private && (!includePrivateDocs || !doc.privateExplicit))) {
    throw new Error("clickup_v4_private_docs_require_explicit_consent");
  }
  return docs;
}

function achatarPaginas(valor) {
  const resultado = [];
  const visitar = (itens) => {
    for (const item of itens) {
      const pagina = registro(item);
      if (texto(pagina.id ?? pagina.page_id)) resultado.push(pagina);
      visitar(lista(pagina.pages ?? pagina.children ?? pagina.subpages));
    }
  };
  const raw = registro(valor);
  visitar(lista(raw.pages ?? raw.data ?? valor));
  return resultado;
}

async function requisitar(fetchImpl, token, url, dormir) {
  for (let tentativa = 0; tentativa < 4; tentativa += 1) {
    const resposta = await fetchImpl(url, {
      headers: { Authorization: token, Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (resposta.ok) return resposta.json();
    if ((resposta.status === 429 || resposta.status >= 500) && tentativa < 3) {
      const retryAfter = Number(resposta.headers.get("retry-after") ?? 0);
      await dormir(retryAfter > 0 ? retryAfter * 1_000 : 250 * 2 ** tentativa);
      continue;
    }
    throw new Error(`clickup_v4_http_${resposta.status}`);
  }
  throw new Error("clickup_v4_retry_exhausted");
}

function ipv4Privado(ip) {
  const partes = ip.split(".").map(Number);
  if (partes.length !== 4 || partes.some((parte) => !Number.isInteger(parte))) return true;
  const [a, b] = partes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function enderecoPrivado(ip) {
  if (isIP(ip) === 4) return ipv4Privado(ip);
  if (isIP(ip) !== 6) return true;
  const normal = ip.toLowerCase().split("%")[0];
  if (normal.startsWith("::ffff:")) {
    const cauda = normal.slice(7);
    if (cauda.includes(".")) return ipv4Privado(cauda);
    const partes = cauda.split(":");
    if (partes.length !== 2) return true;
    const alto = Number.parseInt(partes[0], 16);
    const baixo = Number.parseInt(partes[1], 16);
    return ipv4Privado(`${alto >> 8}.${alto & 255}.${baixo >> 8}.${baixo & 255}`);
  }
  return (
    normal === "::" ||
    normal === "::1" ||
    normal.startsWith("fc") ||
    normal.startsWith("fd") ||
    /^fe[89ab]/.test(normal)
  );
}

async function resolverAsset(valor) {
  const url = new URL(valor);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("asset_url_refused");
  if (!HOSTS_DE_ASSET.some((permitido) => host === permitido || host.endsWith(`.${permitido}`)))
    throw new Error("asset_host_refused");
  const enderecos = await dnsLookup(host, { all: true, verbatim: true });
  if (!enderecos.length || enderecos.some(({ address }) => enderecoPrivado(address)))
    throw new Error("asset_private_dns");
  return { url, address: enderecos[0].address };
}

async function fetchPinado(url, address) {
  return new Promise((resolvePromise, reject) => {
    const req = httpsRequest(
      {
        hostname: address,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        headers: { Host: url.host, Accept: "application/octet-stream" },
        timeout: 20_000,
      },
      (res) => {
        const headers = new Headers();
        for (const [nome, valor] of Object.entries(res.headers)) {
          if (Array.isArray(valor)) valor.forEach((item) => headers.append(nome, item));
          else if (valor !== undefined) headers.set(nome, String(valor));
        }
        resolvePromise(
          new Response(Readable.toWeb(res), { status: res.statusCode ?? 500, headers }),
        );
      },
    );
    req.once("timeout", () => req.destroy(new Error("asset_timeout")));
    req.once("error", reject);
    req.end();
  });
}

function farejarMime(bytes) {
  if (bytes.subarray(0, 5).toString("ascii") === "%PDF-") return ["application/pdf", "pdf"];
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")))
    return ["image/png", "png"];
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return ["image/jpeg", "jpg"];
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")))
    return ["image/gif", "gif"];
  if (
    bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
    bytes.subarray(8, 12).toString("ascii") === "WEBP"
  )
    return ["image/webp", "webp"];
  if (
    !bytes.subarray(0, 8_192).includes(0) &&
    !bytes.subarray(0, 8_192).toString("utf8").includes("�")
  )
    return ["text/plain", "txt"];
  throw new Error("asset_unsupported_mime");
}

async function baixarAssetCompleto(urlBruta, outputDir) {
  let resolvido = await resolverAsset(urlBruta);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const resposta = await fetchPinado(resolvido.url, resolvido.address);
    if (resposta.status >= 300 && resposta.status < 400) {
      const destino = resposta.headers.get("location");
      if (!destino || redirects === 3) throw new Error("asset_redirect_refused");
      resolvido = await resolverAsset(new URL(destino, resolvido.url).toString());
      continue;
    }
    if (!resposta.ok || !resposta.body) throw new Error(`asset_download_${resposta.status}`);
    const declarado = Number(resposta.headers.get("content-length") ?? 0);
    if (declarado > MAX_ASSET_BYTES) throw new Error("asset_too_large");
    const reader = resposta.body.getReader();
    const partes = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ASSET_BYTES) {
        await reader.cancel();
        throw new Error("asset_too_large");
      }
      partes.push(Buffer.from(value));
    }
    const bytes = Buffer.concat(partes);
    const [mime, extensao] = farejarMime(bytes);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const blobRef = `blobs/${sha256}.${extensao}`;
    await gravarAtomicoBinario(resolve(outputDir, blobRef), bytes);
    return { sniffed_mime: mime, sha256, blob_ref: blobRef, bytes_downloaded: bytes.length };
  }
  throw new Error("asset_redirect_refused");
}

async function gravarAtomicoBinario(caminho, bytes) {
  await mkdir(dirname(caminho), { recursive: true });
  const temporario = `${caminho}.${process.pid}.tmp`;
  await writeFile(temporario, bytes, { mode: 0o600 });
  await rename(temporario, caminho);
}

function sanitizarMarkdown(valor) {
  return texto(valor)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, "$1")
    .replace(/@/g, "＠")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

function dataIso(valor) {
  const bruta = texto(valor);
  const numero = Number(bruta);
  const data = Number.isFinite(numero) ? new Date(numero) : new Date(bruta);
  if (!bruta || Number.isNaN(data.getTime())) throw new Error("clickup_comment_invalid_date");
  return data.toISOString();
}

function normalizarComentario(taskId, valor, parentCommentId = null) {
  const raw = registro(valor);
  const user = registro(raw.user ?? raw.author);
  const commentId = texto(raw.id ?? raw.comment_id);
  if (!commentId) throw new Error("clickup_comment_missing_identity");
  const segmentos = lista(raw.comment)
    .map((item) => texto(registro(item).text))
    .join("");
  const criado = dataIso(raw.date ?? raw.date_created ?? raw.created_at);
  return {
    comment_id: commentId,
    task_id: taskId,
    parent_comment_id: parentCommentId,
    source_created_at: criado,
    source_updated_at:
      raw.date_updated === undefined && raw.updated_at === undefined
        ? null
        : dataIso(raw.date_updated ?? raw.updated_at),
    author: {
      source_user_id: texto(user.id ?? user.userid ?? raw.user_id) || "unknown",
      display_name:
        texto(user.username ?? user.display_name ?? user.name ?? "Usuário ClickUp")
          .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[e-mail removido]")
          .replace(/[\r\n\t]/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120) || "Usuário ClickUp",
    },
    body_markdown: sanitizarMarkdown(
      raw.body_markdown ?? raw.markdown ?? raw.comment_text ?? segmentos,
    ),
    attachment_ids: [
      ...new Set(
        lista(raw.attachments)
          .map((item) => texto(registro(item).id ?? registro(item).attachment_id))
          .filter(Boolean),
      ),
    ].sort(),
  };
}

function ordenarComReplies(comentarios) {
  const porPai = new Map();
  for (const comentario of comentarios) {
    const grupo = porPai.get(comentario.parent_comment_id) ?? [];
    grupo.push(comentario);
    porPai.set(comentario.parent_comment_id, grupo);
  }
  const ordenar = (itens) =>
    itens.sort(
      (a, b) =>
        a.source_created_at.localeCompare(b.source_created_at) ||
        a.comment_id.localeCompare(b.comment_id),
    );
  const saida = [];
  const visitar = (comentario) => {
    saida.push(comentario);
    for (const reply of ordenar(porPai.get(comentario.comment_id) ?? [])) visitar(reply);
  };
  for (const raiz of ordenar(porPai.get(null) ?? [])) visitar(raiz);
  return saida;
}

async function comentariosDaTask(fetchImpl, token, taskId, dormir) {
  const brutos = [];
  const cursores = new Set();
  let cursor = null;
  while (true) {
    const params = new URLSearchParams();
    if (cursor) {
      params.set("start", cursor.start);
      params.set("start_id", cursor.start_id);
    }
    const resposta = registro(
      await requisitar(
        fetchImpl,
        token,
        `${API_V2}/task/${encodeURIComponent(taskId)}/comment${params.size ? `?${params}` : ""}`,
        dormir,
      ),
    );
    const pagina = lista(resposta.comments).map(registro);
    brutos.push(...pagina);
    if (pagina.length < 25) break;
    const ultimo = pagina.at(-1);
    const proximo = {
      start: texto(ultimo.date ?? ultimo.date_created),
      start_id: texto(ultimo.id ?? ultimo.comment_id),
    };
    const chave = `${proximo.start}\0${proximo.start_id}`;
    if (!proximo.start || !proximo.start_id || cursores.has(chave))
      throw new Error("clickup_comments_cursor_invalid");
    cursores.add(chave);
    cursor = proximo;
  }
  const comments = brutos.map((raw) => normalizarComentario(taskId, raw));
  let replies = 0;
  for (const bruto of brutos) {
    const quantidade = Number(bruto.reply_count ?? bruto.replies_count ?? 0);
    if (!Number.isFinite(quantidade) || quantidade <= 0) continue;
    const parentId = texto(bruto.id ?? bruto.comment_id);
    const resposta = registro(
      await requisitar(
        fetchImpl,
        token,
        `${API_V2}/comment/${encodeURIComponent(parentId)}/reply`,
        dormir,
      ),
    );
    const itens = lista(resposta.comments ?? resposta.replies);
    if (itens.length !== quantidade) throw new Error("clickup_replies_incomplete");
    replies += itens.length;
    comments.push(...itens.map((raw) => normalizarComentario(taskId, raw, parentId)));
  }
  return { comments: ordenarComReplies(comments), topLevel: brutos.length, replies, cursor };
}

async function anexosDaTask(
  fetchImpl,
  token,
  workspaceId,
  taskId,
  dormir,
  { mode, outputDir, processAsset },
) {
  const assets = [];
  const warnings = [];
  const skips = {};
  let bytesDoAlvo = 0;
  let bytesDownloaded = 0;
  let anexosAceitos = 0;
  const pular = (reason, attachmentId) => {
    skips[reason] = (skips[reason] ?? 0) + 1;
    warnings.push({
      code: reason,
      parent_type: "task",
      parent_external_id: taskId,
      attachment_id: attachmentId,
    });
  };
  const cursores = new Set();
  let cursor = null;
  while (true) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const resposta = registro(
      await requisitar(
        fetchImpl,
        token,
        `${API_V3}/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(taskId)}/attachments?${params}`,
        dormir,
      ),
    );
    for (const valor of lista(resposta.attachments ?? resposta.data ?? resposta.items)) {
      const raw = registro(valor);
      const id = texto(raw.id ?? raw.attachment_id);
      if (!id) continue;
      const tamanhoBruto = Number(raw.size ?? raw.size_bytes);
      const tamanho = Number.isFinite(tamanhoBruto) && tamanhoBruto >= 0 ? tamanhoBruto : null;
      if (anexosAceitos >= MAX_ASSETS_PER_TARGET) {
        pular("skipped_target_asset_count_limit", id);
        continue;
      }
      if (tamanho !== null && tamanho > MAX_ASSET_BYTES) {
        pular("skipped_asset_too_large", id);
        continue;
      }
      if (tamanho !== null && bytesDoAlvo + tamanho > MAX_ASSET_BYTES_PER_TARGET) {
        pular("skipped_target_bytes_limit", id);
        continue;
      }
      anexosAceitos += 1;
      bytesDoAlvo += tamanho ?? 0;
      const base = {
        attachment_id: id,
        parent_type: "task",
        parent_external_id: taskId,
        file_name: texto(raw.file_name ?? raw.filename ?? raw.name) || `attachment-${id}`,
        declared_size: tamanho,
        source_revision: texto(raw.updated_at ?? raw.date_updated ?? raw.created_at) || null,
      };
      if (mode === "inventory") {
        assets.push({ ...base, sniffed_mime: null, sha256: null, blob_ref: null });
        continue;
      }
      const sourceUrl = texto(raw.url ?? raw.download_url ?? raw.source_url);
      if (!sourceUrl) {
        pular("skipped_asset_missing_source", id);
        continue;
      }
      try {
        const downloaded = await processAsset(sourceUrl, outputDir);
        if (!Number.isInteger(downloaded.bytes_downloaded) || downloaded.bytes_downloaded <= 0) {
          pular("skipped_asset_empty", id);
          continue;
        }
        if (downloaded.bytes_downloaded > MAX_ASSET_BYTES) {
          pular("skipped_asset_too_large", id);
          continue;
        }
        const bytesEfetivos = bytesDoAlvo - (tamanho ?? 0) + downloaded.bytes_downloaded;
        if (bytesEfetivos > MAX_ASSET_BYTES_PER_TARGET) {
          pular("skipped_target_bytes_limit", id);
          continue;
        }
        bytesDoAlvo = bytesEfetivos;
        assets.push({
          ...base,
          declared_size: downloaded.bytes_downloaded,
          sniffed_mime: downloaded.sniffed_mime,
          sha256: downloaded.sha256,
          blob_ref: downloaded.blob_ref,
        });
        bytesDownloaded += downloaded.bytes_downloaded;
      } catch (error) {
        const code = error instanceof Error ? error.message : "asset_download_failed";
        pular(code.startsWith("asset_") ? `skipped_${code}` : "skipped_asset_download_failed", id);
      }
    }
    const proximo = texto(resposta.next_cursor ?? registro(resposta.meta).next_cursor) || null;
    if (!proximo) break;
    if (cursores.has(proximo)) throw new Error("clickup_attachments_cursor_cycle");
    cursores.add(proximo);
    cursor = proximo;
  }
  return { assets, cursor, warnings, skips, bytesDownloaded };
}

async function anexosDasPaginasDosDocs(
  fetchImpl,
  token,
  workspaceId,
  docs,
  dormir,
  { mode, outputDir, processAsset },
) {
  const assets = [];
  const warnings = [];
  const skips = {};
  const pageIds = [];
  let bytesDownloaded = 0;
  const pular = (reason, pageId, attachmentId) => {
    skips[reason] = (skips[reason] ?? 0) + 1;
    warnings.push({
      code: reason,
      parent_type: "doc_page",
      parent_external_id: pageId,
      attachment_id: attachmentId,
    });
  };
  for (const doc of docs) {
    const base = `${API_V3}/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(doc.id)}/pages`;
    const estrutura = await requisitar(
      fetchImpl,
      token,
      `${base}?max_page_depth=-1&content_format=text%2Fmd`,
      dormir,
    );
    for (const resumo of achatarPaginas(estrutura)) {
      const pageId = texto(resumo.id ?? resumo.page_id);
      if (!pageId) continue;
      pageIds.push(pageId);
      const pagina = registro(
        await requisitar(
          fetchImpl,
          token,
          `${base}/${encodeURIComponent(pageId)}?content_format=text%2Fmd`,
          dormir,
        ),
      );
      let bytesDaPagina = 0;
      let aceitos = 0;
      for (const valor of lista(pagina.attachments ?? registro(pagina.content).attachments)) {
        const raw = registro(valor);
        const id = texto(raw.id ?? raw.attachment_id);
        if (!id) continue;
        const tamanhoBruto = Number(raw.size ?? raw.size_bytes);
        const tamanho = Number.isFinite(tamanhoBruto) && tamanhoBruto >= 0 ? tamanhoBruto : null;
        if (aceitos >= MAX_ASSETS_PER_TARGET) {
          pular("skipped_target_asset_count_limit", pageId, id);
          continue;
        }
        if (tamanho !== null && tamanho > MAX_ASSET_BYTES) {
          pular("skipped_asset_too_large", pageId, id);
          continue;
        }
        if (tamanho !== null && bytesDaPagina + tamanho > MAX_ASSET_BYTES_PER_TARGET) {
          pular("skipped_target_bytes_limit", pageId, id);
          continue;
        }
        aceitos += 1;
        bytesDaPagina += tamanho ?? 0;
        const baseAsset = {
          attachment_id: id,
          parent_type: "doc_page",
          parent_external_id: pageId,
          file_name: texto(raw.file_name ?? raw.filename ?? raw.name) || `attachment-${id}`,
          declared_size: tamanho,
          source_revision: texto(raw.updated_at ?? raw.date_updated ?? raw.created_at) || null,
        };
        if (mode === "inventory") {
          assets.push({ ...baseAsset, sniffed_mime: null, sha256: null, blob_ref: null });
          continue;
        }
        const sourceUrl = texto(raw.download_url ?? raw.url ?? raw.source_url);
        if (!sourceUrl) {
          pular("skipped_asset_missing_source", pageId, id);
          continue;
        }
        try {
          const downloaded = await processAsset(sourceUrl, outputDir);
          if (!Number.isInteger(downloaded.bytes_downloaded) || downloaded.bytes_downloaded <= 0) {
            pular("skipped_asset_empty", pageId, id);
            continue;
          }
          if (downloaded.bytes_downloaded > MAX_ASSET_BYTES) {
            pular("skipped_asset_too_large", pageId, id);
            continue;
          }
          const bytesEfetivos = bytesDaPagina - (tamanho ?? 0) + downloaded.bytes_downloaded;
          if (bytesEfetivos > MAX_ASSET_BYTES_PER_TARGET) {
            pular("skipped_target_bytes_limit", pageId, id);
            continue;
          }
          bytesDaPagina = bytesEfetivos;
          assets.push({
            ...baseAsset,
            declared_size: downloaded.bytes_downloaded,
            sniffed_mime: downloaded.sniffed_mime,
            sha256: downloaded.sha256,
            blob_ref: downloaded.blob_ref,
          });
          bytesDownloaded += downloaded.bytes_downloaded;
        } catch (error) {
          const code = error instanceof Error ? error.message : "asset_download_failed";
          pular(
            code.startsWith("asset_") ? `skipped_${code}` : "skipped_asset_download_failed",
            pageId,
            id,
          );
        }
      }
    }
  }
  return {
    assets,
    pageIds: [...new Set(pageIds)].sort(),
    warnings,
    skips,
    bytesDownloaded,
  };
}

export async function exportarClickUpV4(opcoes, deps = {}) {
  const token = opcoes.token?.trim();
  if (
    !token ||
    !opcoes.tasks ||
    !opcoes.workspaceId ||
    !opcoes.connectionId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      opcoes.runId ?? "",
    ) ||
    !/^[0-9a-f]{64}$/.test(opcoes.snapshotHash ?? "")
  )
    throw new Error("clickup_v4_options_missing");
  if (!["inventory", "full"].includes(opcoes.mode ?? "inventory"))
    throw new Error("clickup_v4_mode_invalid");
  const mode = opcoes.mode ?? "inventory";
  if (mode === "full" && !opcoes.docsManifest) {
    throw new Error("clickup_v4_full_requires_docs_manifest");
  }
  const taskIds = await idsDasTasks(opcoes.tasks);
  const docs = opcoes.docsManifest
    ? await docsDoManifesto(opcoes.docsManifest, opcoes.workspaceId, opcoes.includePrivateDocs)
    : [];
  const tasksExpected = Number(opcoes.tasksExpected ?? TASKS_ESPERADAS);
  const out = resolve(opcoes.out ?? "clickup-export-v4.json");
  const checkpoint = resolve(opcoes.checkpoint ?? `${out}.checkpoint`);
  const checkpointMeta = resolve(checkpoint, "state.json");
  const inicial = {
    checkpoint_version: 1,
    run_id: opcoes.runId,
    snapshot_hash: opcoes.snapshotHash,
    workspace_id: opcoes.workspaceId,
    mode: opcoes.mode ?? "inventory",
  };
  const estado = opcoes.resume ? await lerJson(checkpointMeta, inicial) : inicial;
  if (
    estado.workspace_id !== opcoes.workspaceId ||
    estado.mode !== (opcoes.mode ?? "inventory") ||
    estado.run_id !== opcoes.runId ||
    estado.snapshot_hash !== opcoes.snapshotHash
  )
    throw new Error("clickup_v4_checkpoint_incompatible");
  const taskResults = opcoes.resume
    ? await carregarTasksDoCheckpoint(checkpoint, estado.run_id)
    : {};
  if (!opcoes.resume) await gravarAtomico(checkpointMeta, estado);
  const fetchImpl = deps.fetchImpl ?? fetch;
  const dormir =
    deps.dormir ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
  for (const taskId of taskIds) {
    if (taskResults[taskId]) continue;
    const [comentarios, anexos] = await Promise.all([
      comentariosDaTask(fetchImpl, token, taskId, dormir),
      anexosDaTask(fetchImpl, token, opcoes.workspaceId, taskId, dormir, {
        mode,
        outputDir: dirname(out),
        processAsset: deps.processAsset ?? baixarAssetCompleto,
      }),
    ]);
    const comentarioPorAnexo = new Map();
    for (const comentario of comentarios.comments) {
      for (const attachmentId of comentario.attachment_ids) {
        const atual = comentarioPorAnexo.get(attachmentId);
        if (!atual || comentario.comment_id.localeCompare(atual) < 0) {
          comentarioPorAnexo.set(attachmentId, comentario.comment_id);
        }
      }
    }
    const assetsComComentario = anexos.assets.map((asset) => ({
      ...asset,
      ...(comentarioPorAnexo.has(asset.attachment_id)
        ? { comment_id: comentarioPorAnexo.get(asset.attachment_id) }
        : {}),
    }));
    const result = {
      comments: comentarios.comments,
      assets: assetsComComentario,
      comments_terminal_cursor: comentarios.cursor,
      attachments_terminal_cursor: anexos.cursor,
      top_level_count: comentarios.topLevel,
      replies_count: comentarios.replies,
      warnings: anexos.warnings,
      skips: anexos.skips,
      bytes_downloaded: anexos.bytesDownloaded,
    };
    taskResults[taskId] = result;
    await (deps.gravarCheckpointTask ?? gravarCheckpointDaTask)(
      checkpoint,
      estado.run_id,
      taskId,
      result,
    );
  }
  const docPages = await anexosDasPaginasDosDocs(
    fetchImpl,
    token,
    opcoes.workspaceId,
    docs,
    dormir,
    {
      mode,
      outputDir: dirname(out),
      processAsset: deps.processAsset ?? baixarAssetCompleto,
    },
  );
  const expectedDocPageIds = new Set(docs.flatMap((doc) => doc.pageIds));
  const scannedDocPageIds = new Set(docPages.pageIds);
  if (
    mode === "full" &&
    (expectedDocPageIds.size !== scannedDocPageIds.size ||
      [...expectedDocPageIds].some((pageId) => !scannedDocPageIds.has(pageId)))
  ) {
    throw new Error("clickup_v4_doc_pages_coverage_mismatch");
  }
  const tasks = Object.entries(taskResults).sort(([a], [b]) => a.localeCompare(b));
  const comments = tasks.flatMap(([, valor]) => valor.comments);
  const assets = [...tasks.flatMap(([, valor]) => valor.assets), ...docPages.assets];
  const warnings = [
    ...tasks.flatMap(([, valor]) => valor.warnings ?? []),
    ...docPages.warnings,
  ].slice(0, 5_000);
  const skipsPorMotivo = {};
  for (const [, valor] of tasks) {
    for (const [motivo, quantidade] of Object.entries(valor.skips ?? {})) {
      skipsPorMotivo[motivo] = (skipsPorMotivo[motivo] ?? 0) + quantidade;
    }
  }
  for (const [motivo, quantidade] of Object.entries(docPages.skips)) {
    skipsPorMotivo[motivo] = (skipsPorMotivo[motivo] ?? 0) + quantidade;
  }
  if (mode === "inventory" && assets.length) skipsPorMotivo.inventory_only = assets.length;
  const coverage = {
    tasks_expected: tasksExpected,
    tasks_comments_scanned: tasks.length,
    attachment_parents_scanned: tasks.length + docPages.pageIds.length,
    terminal_cursors: [
      ...tasks.map(([id]) => ({
        kind: "task_comments",
        parent_external_id: id,
        cursor: null,
        terminal: true,
      })),
      ...tasks.map(([id]) => ({
        kind: "tasks",
        parent_external_id: id,
        cursor: null,
        terminal: true,
      })),
      ...docPages.pageIds.map((id) => ({
        kind: "doc_pages",
        parent_external_id: id,
        cursor: null,
        terminal: true,
      })),
    ],
    comments_found: comments.length,
    replies_found: comments.filter((comentario) => comentario.parent_comment_id !== null).length,
    assets_found: assets.length,
    bytes_declared: assets.reduce((total, asset) => total + (asset.declared_size ?? 0), 0),
    bytes_downloaded: tasks.reduce(
      (total, [, valor]) => total + (valor.bytes_downloaded ?? 0),
      docPages.bytesDownloaded,
    ),
    warnings,
    skips: Object.entries(skipsPorMotivo)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => ({ reason, count })),
  };
  if (
    mode === "full" &&
    (coverage.tasks_comments_scanned !== coverage.tasks_expected ||
      coverage.attachment_parents_scanned !== tasks.length + docPages.pageIds.length ||
      docPages.pageIds.length !==
        coverage.terminal_cursors.filter((cursor) => cursor.kind === "doc_pages").length)
  ) {
    throw new Error("clickup_v4_full_coverage_incomplete");
  }
  const pacote = {
    sidecar_version: 1,
    manifest_version: 3,
    run_id: estado.run_id,
    workspace_id: opcoes.workspaceId,
    snapshot_hash: opcoes.snapshotHash,
    coverage,
    checkpoint: {
      parent_type: docPages.pageIds.length ? "doc_page" : "task",
      parent_external_id: docPages.pageIds.at(-1) ?? tasks.at(-1)?.[0] ?? opcoes.workspaceId,
      cursor: null,
      terminal: true,
    },
    mode,
    assets,
    comments,
  };
  await gravarAtomico(out, pacote);
  estado.finalized_at = new Date().toISOString();
  await gravarAtomico(checkpointMeta, estado);
  return pacote;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const args = argumentos(argv);
  return exportarClickUpV4({ ...args, token: deps.token ?? process.env.CLICKUP_API_TOKEN }, deps);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((erro) => {
    process.stderr.write(
      `Falha no export ClickUp v4: ${erro instanceof Error ? erro.message : "erro_desconhecido"}\n`,
    );
    process.exitCode = 1;
  });
}
