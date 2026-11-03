import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { isClickUpAssetFinalPathOwnedBy } from "@/lib/clickup/assets/paths";
import { cabecalhoDeDownload } from "@/lib/messaging/media/download-com-nome";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

interface RouteContext {
  params: Promise<{ id: string; attachmentId: string }>;
}

const uuid = z.string().uuid();

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const params = await context.params;
  const taskId = uuid.safeParse(params.id);
  const attachmentId = uuid.safeParse(params.attachmentId);
  if (!taskId.success || !attachmentId.success) {
    return fail("validation_failed", "Anexo inválido.", 422, { requestId });
  }

  const session = await createClient();
  const { data: attachment, error } = await session
    .from("crm_task_attachments")
    .select("id,file_name,file_size,mime_type,storage_path")
    .eq("organization_id", authz.org.orgId)
    .eq("task_id", taskId.data)
    .eq("id", attachmentId.data)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao carregar anexo.", 500, { requestId });
  if (
    !attachment ||
    !isClickUpAssetFinalPathOwnedBy(attachment.storage_path, authz.org.orgId, "tasks", taskId.data)
  ) {
    return fail("not_found", "Anexo não encontrado.", 404, { requestId });
  }

  const { data: blob, error: storageError } = await createAdminClient()
    .storage.from("clickup-assets")
    .download(attachment.storage_path);
  if (storageError || !blob) return fail("not_found", "Anexo não encontrado.", 404, { requestId });
  return new Response(blob, {
    headers: {
      "X-Request-Id": requestId,
      "Cache-Control": "private, no-store",
      "Content-Type": attachment.mime_type || "application/octet-stream",
      "Content-Length": String(attachment.file_size),
      "Content-Disposition": cabecalhoDeDownload(attachment.file_name),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
