import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const taskIdSchema = z.string().uuid();

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const taskId = taskIdSchema.safeParse((await context.params).id);
  if (!taskId.success) return fail("validation_failed", "Tarefa inválida.", 422, { requestId });

  const db = await createClient();
  const { data: task, error: taskError } = await db
    .from("crm_tasks")
    .select("id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", taskId.data)
    .maybeSingle();
  if (taskError) return fail("internal_error", "Erro ao carregar tarefa.", 500, { requestId });
  if (!task) return fail("not_found", "Tarefa não encontrada.", 404, { requestId });

  const { data, error } = await db
    .from("crm_task_attachments")
    .select("id,file_name,file_size,mime_type,created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("task_id", taskId.data)
    .order("created_at", { ascending: true });
  if (error) return fail("internal_error", "Erro ao carregar anexos.", 500, { requestId });

  return ok(
    {
      files: (data ?? []).map((file) => ({
        id: file.id,
        file_name: file.file_name,
        file_size: file.file_size,
        mime_type: file.mime_type,
        media_href: `/api/v1/tasks/${taskId.data}/attachments/${file.id}/media`,
      })),
    },
    { requestId },
  );
}
