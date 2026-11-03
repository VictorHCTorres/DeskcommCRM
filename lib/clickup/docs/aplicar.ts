import type { SupabaseClient } from "@supabase/supabase-js";

import { temChaveDeEmbedding } from "@/lib/ai/embeddings/chave";

import { ingerirDocClickUp, type PortaKnowledgeClickUp } from "./ingestao";
import { portaKnowledgeClickUpSupabase } from "./porta-supabase";

type Row = Record<string, unknown>;

function registro(valor: unknown): Row {
  return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Row) : {};
}

function lista(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : [];
}

export async function aplicarDocClickUp(
  db: SupabaseClient,
  run: Row,
  item: Row,
  deps: {
    temChave?: (organizationId: string) => Promise<boolean>;
    porta?: PortaKnowledgeClickUp;
  } = {},
): Promise<"succeeded" | "skipped"> {
  if (item.entity_type !== "doc") return "skipped";
  if (run.dry_run === true) return "succeeded";
  const payload = registro(item.source_payload);
  if (
    payload.format !== "markdown" ||
    typeof payload.content !== "string" ||
    !payload.content.trim()
  ) {
    throw new Error("clickup_doc_missing_content");
  }
  const metadata = registro(item.source_metadata);
  const organizationId = String(run.organization_id);
  const sourceId = String(item.external_id);
  const privado =
    metadata.private === true ||
    ["PRIVATE", "RESTRICTED"].includes(String(metadata.visibility).toUpperCase());
  const anexos = lista(metadata.attachment_manifest).map((valor) => {
    const anexo = registro(valor);
    const { download_url: _downloadUrl, url: _url, ...seguro } = anexo;
    return {
      ...seguro,
      import_status: "skipped_not_imported",
      warning: "attachment_transport_not_available_in_manifest_v3",
    };
  });
  const resultado = await ingerirDocClickUp(
    {
      organizationId,
      connectionId: String(run.connection_id),
      workspaceId: String(run.workspace_id),
      docId: sourceId,
      name: String(metadata.name ?? metadata.title ?? `Doc ${sourceId}`),
      markdown: payload.content,
      contentHash:
        typeof metadata.content_sha256 === "string" ? metadata.content_sha256 : undefined,
      private: privado,
      privateExplicitlyAuthorized: metadata.private_scope_explicit === true,
      attachmentManifest: anexos,
      importedBy: String(run.created_by),
    },
    deps.porta ?? portaKnowledgeClickUpSupabase(db),
    await (deps.temChave ?? temChaveDeEmbedding)(organizationId),
  );

  const { error } = await db.from("clickup_object_mappings").upsert(
    {
      organization_id: organizationId,
      connection_id: run.connection_id,
      workspace_id: run.workspace_id,
      entity_type: "doc",
      external_id: sourceId,
      source_hash: item.source_hash,
      knowledge_source_id: resultado.sourceId,
      mapping_revision: run.mapping_revision,
      created_by: run.created_by,
    },
    { onConflict: "organization_id,workspace_id,entity_type,external_id" },
  );
  if (error) throw new Error(`clickup_doc_mapping:${error.message}`);
  return "succeeded";
}
