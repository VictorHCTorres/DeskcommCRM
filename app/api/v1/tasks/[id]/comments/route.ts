import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

interface Contexto {
  params: Promise<{ id: string }>;
}

/** Comentários importados são leitura histórica; esta rota não expõe mutação. */
export async function GET(_request: Request, contexto: Contexto): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_task_comments" });
  if (!authz.ok) return authz.response;
  const { id } = await contexto.params;
  const supabase = (await createClient()) as unknown as SupabaseClient;
  const { data: task, error: taskError } = await supabase
    .from("crm_tasks")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (taskError)
    return fail("internal_error", "Não foi possível carregar a tarefa.", 500, { requestId });
  if (!task) return fail("not_found", "Tarefa não encontrada.", 404, { requestId });
  const { data, error } = await supabase
    .from("crm_task_comments")
    .select(
      "id, source_comment_id, parent_source_comment_id, author_display_name, body_markdown, source_created_at, source_updated_at",
    )
    .eq("organization_id", authz.org.orgId)
    .eq("task_id", id)
    .order("source_created_at", { ascending: true })
    .order("source_comment_id", { ascending: true })
    .limit(500);
  if (error)
    return fail("internal_error", "Não foi possível carregar os comentários.", 500, { requestId });
  return ok(
    { comments: data ?? [], read_only: true },
    { requestId, headers: { "Cache-Control": "private, no-store" } },
  );
}
