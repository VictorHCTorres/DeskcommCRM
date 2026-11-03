import { createHash } from "node:crypto";

export interface DocumentoClickUpParaKnowledge {
  organizationId: string;
  connectionId: string;
  workspaceId: string;
  docId: string;
  name: string;
  markdown: string;
  contentHash?: string;
  private: boolean;
  privateExplicitlyAuthorized: boolean;
  attachmentManifest: unknown[];
  importedBy: string;
}

export interface FonteClickUpExistente {
  id: string;
  status: string;
  activeKbVersionId: string | null;
  sourceMetadata: Record<string, unknown>;
}

export interface EscritaDaFonteClickUp {
  id: string;
  organizationId: string;
  name: string;
  sourceMetadata: Record<string, unknown>;
  status: "building" | "ready";
  lastIndexStatus: "indexando" | "sem_credencial";
}

export interface PortaKnowledgeClickUp {
  encontrarFonte(id: string, organizationId: string): Promise<FonteClickUpExistente | null>;
  guardarMarkdown(input: {
    path: string;
    bytes: Buffer;
    contentType: "text/markdown";
  }): Promise<void>;
  criarOuAtualizarFonte(input: EscritaDaFonteClickUp): Promise<void>;
  emitirAtualizacao(input: {
    organizationId: string;
    sourceId: string;
    contentHash: string;
    sourceMetadata: Record<string, unknown>;
  }): Promise<void>;
}

function sha256(valor: string | Buffer): string {
  return createHash("sha256").update(valor).digest("hex");
}

/** UUID estável sem depender de extensão/Postgres para a identidade do Doc. */
export function idDaFonteClickUp(
  organizationId: string,
  connectionId: string,
  docId: string,
): string {
  const hex = sha256(`clickup-doc\0${organizationId}\0${connectionId}\0${docId}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function pathDoMarkdownClickUp(
  organizationId: string,
  connectionId: string,
  docId: string,
  contentHash: string,
): string {
  const identidade = sha256(`${connectionId}\0${docId}`).slice(0, 32);
  return `${organizationId}/clickup/${identidade}/${contentHash}.md`;
}

export type ResultadoDaIngestaoClickUp =
  | { kind: "unchanged"; sourceId: string; indexing: "ready_or_pending" }
  | { kind: "indexing_pending"; sourceId: string; reason: "sem_credencial" }
  | { kind: "queued"; sourceId: string };

/**
 * Promove um Doc para uma única fonte de Knowledge. A versão ativa não aparece
 * nesta escrita: o indexador a troca somente depois de preparar a nova versão.
 */
export async function ingerirDocClickUp(
  input: DocumentoClickUpParaKnowledge,
  porta: PortaKnowledgeClickUp,
  temChaveDeEmbedding: boolean,
): Promise<ResultadoDaIngestaoClickUp> {
  if (input.private && !input.privateExplicitlyAuthorized) {
    throw new Error("clickup_private_doc_requires_admin");
  }
  const markdown = input.markdown.replace(/\r\n?/g, "\n").trim();
  if (!markdown) throw new Error("clickup_doc_missing_content");
  const contentHash = input.contentHash ?? sha256(markdown);
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new Error("clickup_doc_invalid_content_hash");

  const sourceId = idDaFonteClickUp(input.organizationId, input.connectionId, input.docId);
  const existente = await porta.encontrarFonte(sourceId, input.organizationId);
  const unchanged = existente?.sourceMetadata.clickup_content_hash === contentHash;

  const blobPath = pathDoMarkdownClickUp(
    input.organizationId,
    input.connectionId,
    input.docId,
    contentHash,
  );
  const metadata: Record<string, unknown> = {
    ...(existente?.sourceMetadata ?? {}),
    provider: "clickup",
    clickup_connection_id: input.connectionId,
    clickup_workspace_id: input.workspaceId,
    clickup_doc_id: input.docId,
    clickup_content_hash: contentHash,
    clickup_private: input.private,
    clickup_private_scope_explicit: input.private && input.privateExplicitlyAuthorized,
    attachment_manifest: input.attachmentManifest,
    blob_path: blobPath,
    ext: "md",
    mime_type: "text/markdown",
    imported_by: input.importedBy,
  };

  if (!unchanged) {
    await porta.guardarMarkdown({
      path: blobPath,
      bytes: Buffer.from(markdown, "utf8"),
      contentType: "text/markdown",
    });
    await porta.criarOuAtualizarFonte({
      id: sourceId,
      organizationId: input.organizationId,
      name: `ClickUp · ${input.name}`.slice(0, 112) + ` · ${sourceId.slice(0, 6)}`,
      sourceMetadata: metadata,
      status: existente?.activeKbVersionId ? "ready" : "building",
      lastIndexStatus: temChaveDeEmbedding ? "indexando" : "sem_credencial",
    });
  }

  await porta.emitirAtualizacao({
    organizationId: input.organizationId,
    sourceId,
    contentHash,
    sourceMetadata: metadata,
  });

  if (unchanged) return { kind: "unchanged", sourceId, indexing: "ready_or_pending" };

  return temChaveDeEmbedding
    ? { kind: "queued", sourceId }
    : { kind: "indexing_pending", sourceId, reason: "sem_credencial" };
}
