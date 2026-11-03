import { randomUUID } from "node:crypto";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { clickupRunIdSchema } from "@/lib/clickup/contrato";
import { cabecalhoDeDownload } from "@/lib/messaging/media/download-com-nome";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

interface RouteContext {
  params: Promise<{ id: string; assetId: string }>;
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", {
    requestId,
    resource: "clickup_asset_items",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  const params = await context.params;
  const runId = clickupRunIdSchema.safeParse(params.id);
  const assetId = clickupRunIdSchema.safeParse(params.assetId);
  if (!runId.success || !assetId.success) {
    return fail("validation_failed", "Asset inválido.", 422, { requestId });
  }
  const admin = createAdminClient();
  const { data: item, error: itemError } = await admin
    .from("clickup_asset_items")
    .select("attachment_id, workspace_id, final_storage_path, status")
    .eq("organization_id", authz.org.orgId)
    .eq("run_id", runId.data)
    .eq("id", assetId.data)
    .in("status", ["promoted", "unchanged"])
    .maybeSingle();
  if (itemError) return fail("internal_error", "Erro ao carregar asset.", 500, { requestId });
  if (!item) return fail("not_found", "Asset não encontrado.", 404, { requestId });
  const { data: receipt, error: receiptError } = await admin
    .from("clickup_asset_receipts")
    .select("lead_attachment_id, task_attachment_id, knowledge_attachment_id")
    .eq("organization_id", authz.org.orgId)
    .eq("workspace_id", item.workspace_id)
    .eq("attachment_id", item.attachment_id)
    .maybeSingle();
  if (receiptError) return fail("internal_error", "Erro ao autorizar asset.", 500, { requestId });
  if (!receipt) return fail("not_found", "Asset não encontrado.", 404, { requestId });

  const session = await createClient();
  const target = receipt.lead_attachment_id
    ? { table: "crm_lead_attachments", id: receipt.lead_attachment_id }
    : receipt.task_attachment_id
      ? { table: "crm_task_attachments", id: receipt.task_attachment_id }
      : { table: "ai_knowledge_source_attachments", id: receipt.knowledge_attachment_id };
  const { data: attachment, error: attachmentError } = await session
    .from(target.table)
    .select("file_name, mime_type, storage_path")
    .eq("organization_id", authz.org.orgId)
    .eq("id", target.id)
    .maybeSingle();
  if (attachmentError)
    return fail("internal_error", "Erro ao autorizar asset.", 500, { requestId });
  if (
    !attachment ||
    (item.final_storage_path && attachment.storage_path !== item.final_storage_path)
  ) {
    return fail("not_found", "Asset não encontrado.", 404, { requestId });
  }
  const { data: blob, error: storageError } = await admin.storage
    .from("clickup-assets")
    .download(attachment.storage_path);
  if (storageError || !blob) return fail("not_found", "Asset não encontrado.", 404, { requestId });
  return new Response(blob, {
    status: 200,
    headers: {
      "X-Request-Id": requestId,
      "Cache-Control": "private, no-store",
      "Content-Type": attachment.mime_type || "application/octet-stream",
      "Content-Disposition": cabecalhoDeDownload(attachment.file_name),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
