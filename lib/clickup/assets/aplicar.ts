import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { clickupDeterministicId } from "@/lib/clickup/crm/aplicar";
import { logger } from "@/lib/logger";
import { CLICKUP_ASSET_MAX_BYTES } from "@/lib/clickup/sidecar-contrato";

import { CLICKUP_ASSET_MIME_EXTENSIONS, sniffClickUpAssetMime } from "./mime";
import { clickUpAssetFinalPath } from "./paths";

type Row = Record<string, unknown>;
type Target =
  { kind: "lead"; id: string } | { kind: "task"; id: string } | { kind: "knowledge"; id: string };

const BUCKET = "clickup-assets";

function databaseError(prefix: string, error: { message: string } | null) {
  if (error) throw new Error(`${prefix}:${error.message}`);
}

async function resolveTarget(db: SupabaseClient, item: Row): Promise<Target> {
  const organizationId = String(item.organization_id);
  const workspaceId = String(item.workspace_id);
  const parentType = String(item.parent_type);
  const { data, error } = await db
    .from("clickup_object_mappings")
    .select("lead_id, task_id, knowledge_source_id")
    .eq("organization_id", organizationId)
    .eq("workspace_id", workspaceId)
    .eq("entity_type", parentType)
    .eq("external_id", String(item.parent_external_id))
    .maybeSingle();
  databaseError("clickup_asset_mapping", error);
  if (!data) throw new Error("clickup_asset_parent_not_mapped");
  if (data.lead_id) return { kind: "lead", id: String(data.lead_id) };
  if (data.task_id) return { kind: "task", id: String(data.task_id) };
  if (data.knowledge_source_id) return { kind: "knowledge", id: String(data.knowledge_source_id) };
  throw new Error("clickup_asset_parent_not_mapped");
}

async function existingReceipt(db: SupabaseClient, organizationId: string, item: Row) {
  const { data, error } = await db
    .from("clickup_asset_receipts")
    .select("source_sha256, lead_attachment_id, task_attachment_id, knowledge_attachment_id")
    .eq("organization_id", organizationId)
    .eq("workspace_id", String(item.workspace_id))
    .eq("attachment_id", String(item.attachment_id))
    .maybeSingle();
  databaseError("clickup_asset_receipt", error);
  return data;
}

async function consumeQuarantineUpload(
  db: SupabaseClient,
  organizationId: string,
  upload: { id: unknown; storage_path: unknown },
) {
  const { error: updateError } = await db
    .from("clickup_asset_uploads")
    .update({ state: "consumed" })
    .eq("organization_id", organizationId)
    .eq("id", String(upload.id));
  if (updateError) {
    logger.warn("[clickup-assets] quarantine continuará elegível ao expurgo", {
      organization_id: organizationId,
      upload_id: String(upload.id),
      error: updateError.message,
    });
    return "clickup_asset_upload_consume_pending";
  }
  const { data: queued, error: queueError } = await db.rpc("fn_queue_clickup_quarantine_cleanup", {
    p_organization_id: organizationId,
    p_upload_id: String(upload.id),
  });
  if (queueError || queued !== true) {
    logger.warn("[clickup-assets] quarantine consumed aguardará reconciliador", {
      organization_id: organizationId,
      upload_id: String(upload.id),
      error: queueError?.message ?? "cleanup_not_queued",
    });
    return "clickup_asset_quarantine_cleanup_pending";
  }
  const { error: removeError } = await db.storage
    .from(BUCKET)
    .remove([String(upload.storage_path)]);
  if (removeError) {
    logger.warn("[clickup-assets] remoção imediata falhou; fila durável preservada", {
      organization_id: organizationId,
      upload_id: String(upload.id),
      error: removeError.message,
    });
    return "clickup_asset_quarantine_cleanup_pending";
  }
  return null;
}

function finalPath(
  organizationId: string,
  workspaceId: string,
  target: Target,
  sha: string,
  ext: string,
) {
  return clickUpAssetFinalPath({
    organizationId,
    workspaceId,
    targetKind: target.kind === "lead" ? "leads" : target.kind === "task" ? "tasks" : "knowledge",
    targetId: target.id,
    sha256: sha,
    extension: ext,
  });
}

async function commitDomainAttachment(
  db: SupabaseClient,
  item: Row,
  target: Target,
  mime: string,
  size: number,
  path: string,
) {
  const organizationId = String(item.organization_id);
  const workspaceId = String(item.workspace_id);
  const attachmentId = String(item.attachment_id);
  const id = clickupDeterministicId(organizationId, "clickup-asset", workspaceId, attachmentId);
  const { data, error } = await db.rpc("fn_commit_clickup_asset", {
    p_organization_id: organizationId,
    p_item_id: String(item.id),
    p_claim_token: String(item.claim_token),
    p_target_kind: target.kind,
    p_target_id: target.id,
    p_attachment_row_id: id,
    p_mime_type: mime,
    p_file_size: size,
    p_storage_path: path,
  });
  databaseError("clickup_asset_atomic_commit", error);
  const result = String((data as { result?: unknown } | null)?.result ?? "");
  if (result !== "promoted" && result !== "unchanged") {
    throw new Error("clickup_asset_atomic_commit_invalid");
  }
  return result;
}

/** Protocolo recuperável: path/ID determinísticos + receipt create-only. */
export async function applyClickUpAsset(
  db: SupabaseClient,
  item: Row,
  renewLease?: () => Promise<boolean>,
) {
  const renew = async () => {
    if (renewLease && !(await renewLease())) throw new Error("clickup_asset_lease_lost");
  };
  await renew();
  const organizationId = String(item.organization_id);
  const { data: upload, error: uploadError } = await db
    .from("clickup_asset_uploads")
    .select("id, storage_path, sha256, declared_size, state, expires_at")
    .eq("organization_id", organizationId)
    .eq("run_id", String(item.run_id))
    .eq("id", String(item.upload_id))
    .maybeSingle();
  databaseError("clickup_asset_upload", uploadError);
  const receipt = await existingReceipt(db, organizationId, item);
  if (receipt) {
    if (String(receipt.source_sha256) !== String(item.source_sha256)) {
      throw new Error("clickup_asset_create_only_conflict");
    }
    if (upload) {
      const cleanupError = await consumeQuarantineUpload(db, organizationId, upload);
      return {
        outcome: "unchanged" as const,
        finalPath: null,
        errorCode: cleanupError ?? undefined,
      };
    }
    return { outcome: "unchanged" as const, finalPath: null };
  }
  if (item.comment_id) {
    const { data: commentReceipt, error: commentError } = await db
      .from("clickup_comment_receipts")
      .select("source_comment_id")
      .eq("organization_id", organizationId)
      .eq("workspace_id", String(item.workspace_id))
      .eq("source_comment_id", String(item.comment_id))
      .maybeSingle();
    databaseError("clickup_asset_comment_receipt", commentError);
    if (!commentReceipt) throw new Error("clickup_asset_comment_not_applied");
  }
  if (!upload || !["prepared", "uploaded"].includes(String(upload.state))) {
    throw new Error("clickup_asset_upload_not_available");
  }
  const storage = db.storage.from(BUCKET);
  await renew();
  const { data: blob, error: downloadError } = await storage.download(String(upload.storage_path));
  databaseError("clickup_asset_quarantine_download", downloadError);
  if (!blob) throw new Error("clickup_asset_quarantine_missing");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.byteLength > CLICKUP_ASSET_MAX_BYTES) throw new Error("clickup_asset_too_large");
  if (
    bytes.byteLength !== Number(upload.declared_size) ||
    bytes.byteLength !== Number(item.declared_size)
  ) {
    throw new Error("clickup_asset_size_mismatch");
  }
  const sha = createHash("sha256").update(bytes).digest("hex");
  if (sha !== String(upload.sha256) || sha !== String(item.source_sha256)) {
    throw new Error("clickup_asset_sha256_mismatch");
  }
  const mime = sniffClickUpAssetMime(bytes, String(item.sniffed_mime), String(item.file_name));
  if (!mime) {
    const cleanupError = await consumeQuarantineUpload(db, organizationId, upload);
    return {
      outcome: "skipped" as const,
      errorCode: cleanupError ?? "skipped_unsupported_mime",
      finalPath: null,
    };
  }
  if (mime !== String(item.sniffed_mime)) throw new Error("clickup_asset_mime_mismatch");
  const target = await resolveTarget(db, item);
  await renew();
  const path = finalPath(
    organizationId,
    String(item.workspace_id),
    target,
    sha,
    CLICKUP_ASSET_MIME_EXTENSIONS[mime]!,
  );
  const { error: finalUploadError } = await storage.upload(path, bytes, {
    contentType: mime,
    upsert: false,
  });
  if (finalUploadError && !/already exists|duplicate|409/i.test(finalUploadError.message)) {
    throw new Error(`clickup_asset_final_upload:${finalUploadError.message}`);
  }
  await renew();
  let commitResult: "promoted" | "unchanged";
  try {
    commitResult = (await commitDomainAttachment(
      db,
      item,
      target,
      mime,
      bytes.byteLength,
      path,
    )) as "promoted" | "unchanged";
  } catch (error) {
    // O upload final precede o commit SQL. Se lease/cancel/quota/conflito
    // vencerem nessa janela, a RPC só enfileira o blob quando nenhuma linha
    // de domínio o referencia (hash igual pode ser compartilhado).
    const { data: queued, error: cleanupError } = await db.rpc("fn_queue_clickup_asset_orphan", {
      p_organization_id: organizationId,
      p_storage_path: path,
    });
    if (cleanupError || queued !== true) {
      throw new Error(
        `clickup_asset_orphan_cleanup_failed:${cleanupError?.message ?? "cleanup_not_queued"}`,
        { cause: error },
      );
    }
    throw error;
  }
  const cleanupError = await consumeQuarantineUpload(db, organizationId, upload);
  return {
    outcome: commitResult as "promoted" | "unchanged",
    finalPath: commitResult === "promoted" ? path : null,
    errorCode: cleanupError ?? undefined,
  };
}
