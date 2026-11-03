import type { SupabaseClient } from "@supabase/supabase-js";

export interface AssetDoMaterialClickUp {
  id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  source_revision: string | null;
  media_href: string;
}

/** Lista somente metadados autorizados por RLS; bytes seguem no bucket privado. */
export async function listarAssetsDoMaterialClickUp(
  supabase: SupabaseClient,
  input: { organizationId: string; sourceId: string },
): Promise<AssetDoMaterialClickUp[]> {
  const { data, error } = await supabase
    .from("ai_knowledge_source_attachments")
    .select("id, file_name, file_size, mime_type, source_revision")
    .eq("organization_id", input.organizationId)
    .eq("knowledge_source_id", input.sourceId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`clickup_knowledge_assets_read:${error.message}`);
  return (data ?? []).map((asset) => ({
    ...(asset as Omit<AssetDoMaterialClickUp, "media_href">),
    media_href: `/api/v1/ai/knowledge/sources/${input.sourceId}/attachments/${asset.id}/media`,
  }));
}
