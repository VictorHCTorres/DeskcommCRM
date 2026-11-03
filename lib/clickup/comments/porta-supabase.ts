import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  DestinoDaTaskClickUp,
  MappingDeComentarioClickUp,
  PortaDeComentariosClickUp,
} from "./aplicar";

type Row = Record<string, unknown>;

function linha(valor: unknown): Row | null {
  return valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Row) : null;
}

export function portaDeComentariosClickUpSupabase(input: {
  admin: SupabaseClient;
  organizationId: string;
  workspaceId: string;
}): PortaDeComentariosClickUp {
  const { admin, organizationId, workspaceId } = input;
  return {
    async resolverDestino(taskId): Promise<DestinoDaTaskClickUp | null> {
      const { data, error } = await admin
        .from("clickup_object_mappings")
        .select("lead_id, task_id")
        .eq("organization_id", organizationId)
        .eq("workspace_id", workspaceId)
        .eq("entity_type", "task")
        .eq("external_id", taskId)
        .maybeSingle();
      if (error) throw new Error(`clickup_comment_target_read:${error.message}`);
      const row = linha(data);
      if (!row) return null;
      if (typeof row.lead_id === "string") {
        return { kind: "lead", organizationId, targetId: row.lead_id };
      }
      if (typeof row.task_id === "string") {
        return { kind: "task", organizationId, targetId: row.task_id };
      }
      return null;
    },

    async encontrarMapping(commentId): Promise<MappingDeComentarioClickUp | null> {
      const { data, error } = await admin
        .from("clickup_comment_receipts")
        .select("source_hash, lead_activity_id, task_comment_id")
        .eq("organization_id", organizationId)
        .eq("workspace_id", workspaceId)
        .eq("source_comment_id", commentId)
        .maybeSingle();
      if (error) throw new Error(`clickup_comment_receipt_read:${error.message}`);
      const receipt = linha(data);
      if (!receipt) return null;
      if (typeof receipt.lead_activity_id === "string") {
        const { data: activity, error: activityError } = await admin
          .from("crm_lead_activities")
          .select("lead_id")
          .eq("organization_id", organizationId)
          .eq("id", receipt.lead_activity_id)
          .maybeSingle();
        if (activityError)
          throw new Error(`clickup_comment_activity_read:${activityError.message}`);
        const targetId = linha(activity)?.lead_id;
        if (typeof targetId !== "string") return null;
        return {
          sourceHash: String(receipt.source_hash),
          destinationId: receipt.lead_activity_id,
          targetKind: "lead",
          targetId,
        };
      }
      if (typeof receipt.task_comment_id === "string") {
        const { data: comment, error: commentError } = await admin
          .from("crm_task_comments")
          .select("task_id")
          .eq("organization_id", organizationId)
          .eq("id", receipt.task_comment_id)
          .maybeSingle();
        if (commentError) throw new Error(`clickup_comment_task_read:${commentError.message}`);
        const targetId = linha(comment)?.task_id;
        if (typeof targetId !== "string") return null;
        return {
          sourceHash: String(receipt.source_hash),
          destinationId: receipt.task_comment_id,
          targetKind: "task",
          targetId,
        };
      }
      return null;
    },

    async gravarAtividadeHistorica(value) {
      const { error } = await admin.rpc("fn_apply_clickup_lead_comment", {
        p_organization_id: organizationId,
        p_workspace_id: workspaceId,
        p_comment_id: String(value.payload.clickup_comment_id),
        p_lead_id: value.leadId,
        p_source_hash: String(value.payload.source_hash ?? ""),
        p_source_created_at: value.performedAt,
        p_source_updated_at: value.payload.source_updated_at ?? null,
        p_parent_comment_id: value.payload.clickup_parent_comment_id ?? null,
        p_source_user_id: String((value.payload.author as Row).source_user_id),
        p_author_display_name: String((value.payload.author as Row).display_name),
        p_body_markdown: String(value.payload.body_markdown),
      });
      if (error) throw new Error(`clickup_lead_comment_apply:${error.message}`);
    },

    async gravarComentarioDeTask(value) {
      const { error } = await admin.rpc("fn_apply_clickup_task_comment", {
        p_organization_id: organizationId,
        p_workspace_id: workspaceId,
        p_comment_id: value.sourceCommentId,
        p_task_id: value.taskId,
        p_parent_comment_id: value.parentSourceCommentId,
        p_source_hash: value.sourceHash,
        p_source_user_id: value.author.source_user_id,
        p_author_display_name: value.author.display_name,
        p_body_markdown: value.bodyMarkdown,
        p_source_created_at: value.sourceCreatedAt,
        p_source_updated_at: value.sourceUpdatedAt,
      });
      if (error) throw new Error(`clickup_task_comment_apply:${error.message}`);
    },

    async registrarMapping() {
      // As RPCs gravam o receipt na mesma transação do destino.
    },
  };
}
