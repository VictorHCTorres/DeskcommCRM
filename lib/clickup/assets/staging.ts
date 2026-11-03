import { z } from "zod";

import type { ClickUpSidecar } from "@/lib/clickup/sidecar-contrato";

const uploadId = z.string().uuid();

export interface ClickUpBlobReceipt {
  attachment_id: string;
  blob_ref: string;
  upload_id: string;
}

/**
 * Resolve a referência portátil do bundle para o receipt privado criado pelo
 * servidor. O cliente nunca fornece o path de quarantine nem o path final.
 */
export function resolveClickUpSidecarBlobReceipts(
  sidecar: ClickUpSidecar,
  receipts: readonly ClickUpBlobReceipt[],
) {
  if (sidecar.mode === "inventory") {
    if (receipts.length > 0) throw new Error("clickup_asset_upload_receipt_unexpected");
    return sidecar;
  }

  const byAttachmentId = new Map<string, ClickUpBlobReceipt>();
  const uploadIds = new Set<string>();
  for (const receipt of receipts) {
    if (byAttachmentId.has(receipt.attachment_id) || uploadIds.has(receipt.upload_id)) {
      throw new Error("clickup_asset_upload_receipt_duplicate");
    }
    if (!uploadId.safeParse(receipt.upload_id).success) {
      throw new Error("clickup_asset_upload_receipt_invalid");
    }
    byAttachmentId.set(receipt.attachment_id, receipt);
    uploadIds.add(receipt.upload_id);
  }

  const expected = new Set(sidecar.assets.map((asset) => asset.attachment_id));
  if (receipts.some((receipt) => !expected.has(receipt.attachment_id))) {
    throw new Error("clickup_asset_upload_receipt_unexpected");
  }

  return {
    ...sidecar,
    assets: sidecar.assets.map((asset) => {
      const receipt = byAttachmentId.get(asset.attachment_id);
      if (!receipt || receipt.blob_ref !== asset.blob_ref) {
        throw new Error("clickup_asset_upload_receipt_required");
      }
      return { ...asset, blob_ref: receipt.upload_id };
    }),
  };
}

export function assertCompleteClickUpFullCoverage(
  sidecar: ClickUpSidecar,
  stagedTaskIds: readonly string[],
  stagedDocPageIds: readonly string[] = [],
) {
  if (sidecar.mode !== "full") return;
  const expected = new Set(stagedTaskIds);
  const cursors = (kind: "tasks" | "task_comments") =>
    new Set(
      sidecar.coverage.terminal_cursors
        .filter((cursor) => cursor.kind === kind && cursor.terminal)
        .map((cursor) => cursor.parent_external_id)
        .filter((id): id is string => typeof id === "string"),
    );
  const sameSet = (actual: Set<string>) =>
    actual.size === expected.size && [...expected].every((id) => actual.has(id));
  const docPages = new Set(
    sidecar.coverage.terminal_cursors
      .filter((cursor) => cursor.kind === "doc_pages" && cursor.terminal)
      .map((cursor) => cursor.parent_external_id)
      .filter((id): id is string => typeof id === "string"),
  );
  const expectedDocPages = new Set(stagedDocPageIds);
  if (
    sidecar.coverage.tasks_expected !== expected.size ||
    sidecar.coverage.tasks_comments_scanned !== expected.size ||
    sidecar.coverage.attachment_parents_scanned !== expected.size + expectedDocPages.size ||
    !sameSet(cursors("tasks")) ||
    !sameSet(cursors("task_comments")) ||
    docPages.size !== expectedDocPages.size ||
    [...expectedDocPages].some((id) => !docPages.has(id))
  ) {
    throw new Error("clickup_sidecar_incomplete_coverage");
  }
}
