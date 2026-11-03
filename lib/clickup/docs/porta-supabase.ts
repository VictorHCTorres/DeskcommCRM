import type { SupabaseClient } from "@supabase/supabase-js";

import { BUCKET_DE_CONHECIMENTO } from "@/lib/ai/rag/ingest/documento";
import type { Database } from "@/lib/database.types";

import type {
  EscritaDaFonteClickUp,
  FonteClickUpExistente,
  PortaKnowledgeClickUp,
} from "./ingestao";

type MetadataJson =
  Database["public"]["Tables"]["ai_knowledge_sources"]["Insert"]["source_metadata"];

function registro(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

function jaExisteNoStorage(
  erro: { message?: string; statusCode?: string | number } | null,
): boolean {
  if (!erro) return false;
  return String(erro.statusCode) === "409" || /already exists|duplicate/i.test(erro.message ?? "");
}

export function portaKnowledgeClickUpSupabase(
  admin: SupabaseClient<Database>,
): PortaKnowledgeClickUp {
  return {
    async encontrarFonte(id, organizationId): Promise<FonteClickUpExistente | null> {
      const { data, error } = await admin
        .from("ai_knowledge_sources")
        .select("id, status, active_kb_version_id, source_metadata")
        .eq("id", id)
        .eq("organization_id", organizationId)
        .maybeSingle();
      if (error) throw new Error(`clickup_knowledge_source_read:${error.message}`);
      if (!data) return null;
      return {
        id: data.id,
        status: data.status,
        activeKbVersionId: data.active_kb_version_id,
        sourceMetadata: registro(data.source_metadata),
      };
    },

    async guardarMarkdown(input) {
      const { error } = await admin.storage
        .from(BUCKET_DE_CONHECIMENTO)
        .upload(input.path, input.bytes, { contentType: input.contentType, upsert: false });
      if (error && !jaExisteNoStorage(error)) {
        throw new Error(`clickup_knowledge_blob_write:${error.message}`);
      }
    },

    async criarOuAtualizarFonte(input: EscritaDaFonteClickUp) {
      const { error } = await admin.from("ai_knowledge_sources").upsert(
        {
          id: input.id,
          organization_id: input.organizationId,
          agent_id: null,
          source_type: "documento",
          name: input.name,
          source_metadata: input.sourceMetadata as MetadataJson,
          status: input.status,
          is_active: true,
          ingested_at: new Date().toISOString(),
          last_index_status: input.lastIndexStatus,
          last_index_error: null,
        },
        { onConflict: "id" },
      );
      if (error) throw new Error(`clickup_knowledge_source_write:${error.message}`);
    },

    async emitirAtualizacao(input) {
      const { error } = await admin.rpc(
        "fn_emit_clickup_knowledge_update" as never,
        {
          p_organization_id: input.organizationId,
          p_source_id: input.sourceId,
          p_content_hash: input.contentHash,
          p_metadata: input.sourceMetadata,
        } as never,
      );
      if (error) throw new Error(`clickup_knowledge_event:${error.message}`);
    },
  };
}
