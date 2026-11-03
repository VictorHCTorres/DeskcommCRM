import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { portaDeComentariosClickUpSupabase } from "./porta-supabase";

describe("porta service-only de comentários ClickUp", () => {
  it("aplica comentário de Task pela RPC histórica com hash create-only", async () => {
    const rpc = vi.fn(async () => ({ data: { result: "created" }, error: null }));
    const porta = portaDeComentariosClickUpSupabase({
      admin: { rpc } as unknown as SupabaseClient,
      organizationId: "org",
      workspaceId: "wk",
    });
    await porta.gravarComentarioDeTask({
      id: "destino",
      organizationId: "org",
      taskId: "task",
      sourceCommentId: "c1",
      sourceHash: "a".repeat(64),
      parentSourceCommentId: "pai",
      bodyMarkdown: "Texto",
      author: { source_user_id: "u1", display_name: "Autor" },
      sourceCreatedAt: "2024-11-03T04:50:00.000Z",
      sourceUpdatedAt: null,
      readOnly: true,
    });
    expect(rpc).toHaveBeenCalledWith("fn_apply_clickup_task_comment", {
      p_organization_id: "org",
      p_workspace_id: "wk",
      p_comment_id: "c1",
      p_task_id: "task",
      p_parent_comment_id: "pai",
      p_source_hash: "a".repeat(64),
      p_source_user_id: "u1",
      p_author_display_name: "Autor",
      p_body_markdown: "Texto",
      p_source_created_at: "2024-11-03T04:50:00.000Z",
      p_source_updated_at: null,
    });
  });

  it("aplica atividade de lead pela RPC que não emite efeitos históricos", async () => {
    const rpc = vi.fn(async () => ({ data: { result: "created" }, error: null }));
    const porta = portaDeComentariosClickUpSupabase({
      admin: { rpc } as unknown as SupabaseClient,
      organizationId: "org",
      workspaceId: "wk",
    });
    await porta.gravarAtividadeHistorica({
      id: "destino",
      organizationId: "org",
      leadId: "lead",
      type: "clickup_comment_imported",
      actorKind: "system",
      performedAt: "2024-11-03T04:50:00.000Z",
      payload: {
        clickup_comment_id: "c1",
        clickup_parent_comment_id: null,
        source_hash: "b".repeat(64),
        source_updated_at: null,
        author: { source_user_id: "u1", display_name: "Autor" },
        body_markdown: "Texto",
      },
    });
    expect(rpc).toHaveBeenCalledWith(
      "fn_apply_clickup_lead_comment",
      expect.objectContaining({ p_source_hash: "b".repeat(64), p_lead_id: "lead" }),
    );
  });
});
