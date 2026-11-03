import type { SupabaseClient } from "@supabase/supabase-js";

import { clickupSidecarCommentSchema } from "@/lib/clickup/sidecar-contrato";

import { aplicarComentariosClickUp } from "./aplicar";
import { portaDeComentariosClickUpSupabase } from "./porta-supabase";

type Row = Record<string, unknown>;

/** Aplica o item já reivindicado; a RPC da porta grava destino+receipt atomicamente. */
export async function applyClickUpCommentItem(db: SupabaseClient, run: Row, item: Row) {
  const comment = clickupSidecarCommentSchema.parse(item.source_metadata);
  if (
    comment.comment_id !== String(item.external_id) ||
    comment.task_id !== String(item.parent_external_id)
  ) {
    throw new Error("clickup_comment_staging_identity_mismatch");
  }
  const [result] = await aplicarComentariosClickUp({
    workspaceId: String(run.workspace_id),
    comments: [comment],
    porta: portaDeComentariosClickUpSupabase({
      admin: db,
      organizationId: String(run.organization_id),
      workspaceId: String(run.workspace_id),
    }),
  });
  if (!result) throw new Error("clickup_comment_apply_without_result");
  if (result.outcome === "conflict") throw new Error("clickup_create_only_source_changed");
  if (result.outcome === "blocked") throw new Error("clickup_parent_comment_not_applied");
  return result.outcome;
}
