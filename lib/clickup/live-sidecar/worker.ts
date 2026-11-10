import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { baixarAnexoSeguro } from "@/lib/clickup/docs/anexos-seguros";
import { CLICKUP_ASSET_MIME_EXTENSIONS } from "@/lib/clickup/assets/mime";
import { decryptClickUpToken } from "@/lib/clickup/crypto";
import { resolveClickUpSidecarBlobReceipts } from "@/lib/clickup/assets/staging";
import { ClickUpDocsV3Client } from "@/lib/clickup/docs/cliente-v3";
import {
  CLICKUP_ASSET_MAX_BYTES,
  CLICKUP_ASSET_MAX_BYTES_PER_TARGET,
  CLICKUP_ASSET_MAX_PER_TARGET,
  clickupSidecarSchema,
} from "@/lib/clickup/sidecar-contrato";
import {
  claimClickUpLiveSidecarParent,
  finishClickUpLiveSidecarParent,
  heartbeatClickUpLiveSidecarParent,
  loadClickUpConnectionSecret,
  prepareClickUpAssetUpload,
  seedClickUpLiveDocPages,
  stageClickUpAssetSidecar,
} from "@/lib/clickup/store";

import { ClienteLiveSidecarClickUp } from "./cliente";
import { clickupLiveParentResultSchema, type ClickUpLiveParentResult } from "./contrato";

type Row = Record<string, unknown>;

async function collectTask(
  db: SupabaseClient,
  job: Row,
  parent: Row,
  token: string,
  renewLease: () => Promise<boolean>,
  deadlineAt: number,
): Promise<ClickUpLiveParentResult> {
  const parentId = String(parent.external_id);
  const parentType = String(parent.parent_type) as "task" | "doc_page";
  const workspaceId = String(job.workspace_id);
  const client = new ClienteLiveSidecarClickUp({ token, deadlineAt });
  const [comments, remoteAssets] =
    parentType === "task"
      ? await Promise.all([
          client.comments.listarDaTask(parentId),
          client.listarAssetsDaTask(workspaceId, parentId),
        ])
      : [
          { comments: [], topLevelCount: 0, repliesCount: 0, terminalCursor: null },
          await client.listarAssetsDaPagina(
            workspaceId,
            String(parent.source_container_id),
            parentId,
          ),
        ];
  const commentByAsset = new Map<string, string>();
  for (const comment of comments.comments) {
    for (const attachmentId of comment.attachment_ids) {
      if (!commentByAsset.has(attachmentId)) commentByAsset.set(attachmentId, comment.comment_id);
    }
  }
  const assets: Array<Record<string, unknown>> = [];
  const blobReceipts: Array<{ attachment_id: string; blob_ref: string; upload_id: string }> = [];
  const warnings: Array<{ code: string; attachment_id?: string }> = [];
  let bytesDownloaded = 0;
  let targetBytes = 0;
  for (const remote of remoteAssets) {
    if (!(await renewLease())) throw new Error("clickup_live_lease_lost");
    if (assets.length >= CLICKUP_ASSET_MAX_PER_TARGET) {
      warnings.push({
        code: "skipped_target_asset_count_limit",
        attachment_id: remote.attachmentId,
      });
      continue;
    }
    if (remote.declaredSize !== null && remote.declaredSize > CLICKUP_ASSET_MAX_BYTES) {
      warnings.push({ code: "skipped_asset_too_large", attachment_id: remote.attachmentId });
      continue;
    }
    const base = {
      attachment_id: remote.attachmentId,
      parent_type: parentType,
      parent_external_id: parentId,
      ...(parentType === "task" && commentByAsset.has(remote.attachmentId)
        ? { comment_id: commentByAsset.get(remote.attachmentId) }
        : {}),
      file_name: remote.fileName.slice(0, 255),
      declared_size: remote.declaredSize,
      source_revision: remote.sourceRevision,
    };
    if (job.mode === "inventory") {
      assets.push({ ...base, sniffed_mime: null, sha256: null, blob_ref: null });
      continue;
    }
    if (!remote.sourceUrl) {
      warnings.push({ code: "skipped_asset_missing_source", attachment_id: remote.attachmentId });
      continue;
    }
    try {
      const downloaded = await baixarAnexoSeguro(remote.sourceUrl, {
        maxBytes: CLICKUP_ASSET_MAX_BYTES,
      });
      if (targetBytes + downloaded.bytes.byteLength > CLICKUP_ASSET_MAX_BYTES_PER_TARGET) {
        warnings.push({ code: "skipped_target_bytes_limit", attachment_id: remote.attachmentId });
        continue;
      }
      const sha256 = createHash("sha256").update(downloaded.bytes).digest("hex");
      const extension = CLICKUP_ASSET_MIME_EXTENSIONS[downloaded.mime];
      if (!extension) throw new Error("attachment_mime_refused");
      const blobRef = `blobs/${sha256}.${extension}`;
      const upload = await prepareClickUpAssetUpload(db, {
        organizationId: String(job.organization_id),
        userId: String(job.created_by),
        runId: String(job.run_id),
        kind: "asset",
        attachmentId: remote.attachmentId,
        sha256,
        declaredSize: downloaded.bytes.byteLength,
      });
      const { error: uploadError } = await db.storage
        .from("clickup-assets")
        .upload(String(upload.storage_path), downloaded.bytes, {
          contentType: downloaded.mime,
          upsert: false,
        });
      if (uploadError) throw new Error(`clickup_live_asset_upload:${uploadError.message}`);
      const { error: stateError } = await db
        .from("clickup_asset_uploads")
        .update({ state: "uploaded" })
        .eq("organization_id", String(job.organization_id))
        .eq("id", String(upload.id))
        .eq("state", "prepared");
      if (stateError) throw new Error(`clickup_live_asset_receipt:${stateError.message}`);
      targetBytes += downloaded.bytes.byteLength;
      bytesDownloaded += downloaded.bytes.byteLength;
      assets.push({
        ...base,
        declared_size: downloaded.bytes.byteLength,
        sniffed_mime: downloaded.mime,
        sha256,
        blob_ref: blobRef,
      });
      blobReceipts.push({
        attachment_id: remote.attachmentId,
        blob_ref: blobRef,
        upload_id: String(upload.id),
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : "attachment_download_failed";
      warnings.push({
        code: code.startsWith("attachment_") ? `skipped_${code}` : "skipped_asset_download_failed",
        attachment_id: remote.attachmentId,
      });
    }
  }
  if (job.mode === "full" && warnings.length > 0) {
    throw new Error("clickup_live_full_asset_incomplete");
  }
  return clickupLiveParentResultSchema.parse({
    comments: comments.comments,
    assets,
    blob_receipts: blobReceipts,
    comments_terminal: true,
    assets_terminal: true,
    replies_found: comments.repliesCount,
    bytes_downloaded: bytesDownloaded,
    warnings,
  });
}

function emptyParentResult(): ClickUpLiveParentResult {
  return clickupLiveParentResultSchema.parse({
    comments: [],
    assets: [],
    blob_receipts: [],
    comments_terminal: true,
    assets_terminal: true,
    replies_found: 0,
    bytes_downloaded: 0,
    warnings: [],
  });
}

async function collectDocsInventory(
  db: SupabaseClient,
  job: Row,
  parent: Row,
  token: string,
  renewLease: () => Promise<boolean>,
  deadlineAt: number,
): Promise<ClickUpLiveParentResult> {
  const client = new ClickUpDocsV3Client({
    token,
    workspaceId: String(job.workspace_id),
    deadlineAt,
  });
  const discoveredDocs = await client.listarDocs({
    incluirPrivados: true,
    aoCheckpoint: async () => {
      if (!(await renewLease())) throw new Error("clickup_live_lease_lost");
    },
  });
  const docs = discoveredDocs.filter((doc) => job.include_private_docs === true || !doc.private);
  for (const doc of docs) {
    if (!(await renewLease())) throw new Error("clickup_live_lease_lost");
    const pageIds = await client.listarPaginas(doc.id);
    await seedClickUpLiveDocPages(db, {
      organizationId: String(job.organization_id),
      parentId: String(parent.id),
      claimToken: String(parent.claim_token),
      pages: pageIds.map((pageId) => ({ doc_id: doc.id, page_id: pageId })),
    });
  }
  const { error: checkpointError } = await db
    .from("clickup_sidecar_collection_jobs")
    .update({
      checkpoint: {
        ...((job.checkpoint as Record<string, unknown> | null) ?? {}),
        docs_discovered: discoveredDocs.length,
        docs_selected: docs.length,
        private_docs_excluded_by_decision: discoveredDocs.length - docs.length,
      },
    })
    .eq("organization_id", String(job.organization_id))
    .eq("id", String(job.id));
  if (checkpointError) throw new Error("clickup_live_docs_checkpoint_failed");
  if (job.mode === "full" && docs.length > 0) {
    throw new Error("clickup_live_docs_content_not_supported");
  }
  return emptyParentResult();
}

async function finalizeReadyJob(db: SupabaseClient): Promise<boolean> {
  const { data: job } = await db
    .from("clickup_sidecar_collection_jobs")
    .select("*")
    .eq("status", "finalizing")
    .order("updated_at")
    .limit(1)
    .maybeSingle();
  if (!job) return false;
  const { data: parents, error } = await db
    .from("clickup_sidecar_collection_parents")
    .select("external_id,parent_type,result")
    .eq("organization_id", job.organization_id)
    .eq("job_id", job.id)
    .eq("status", "completed")
    .order("external_id");
  if (error) throw new Error(`clickup_live_results:${error.message}`);
  const domainParents = (parents ?? []).filter((row) => row.parent_type !== "docs_inventory");
  const results = domainParents.map((row) => clickupLiveParentResultSchema.parse(row.result));
  const comments = results.flatMap((result) => result.comments);
  const assets = results.flatMap((result) => result.assets);
  const receipts = results.flatMap((result) => result.blob_receipts);
  const taskIds = domainParents
    .filter((row) => row.parent_type === "task")
    .map((row) => String(row.external_id));
  const docPageIds = domainParents
    .filter((row) => row.parent_type === "doc_page")
    .map((row) => String(row.external_id));
  const terminalCursors: Array<{
    kind: "tasks" | "task_comments" | "doc_pages";
    parent_external_id: string;
    cursor: null;
    terminal: true;
  }> = taskIds.flatMap((id) => [
    { kind: "tasks" as const, parent_external_id: id, cursor: null, terminal: true as const },
    {
      kind: "task_comments" as const,
      parent_external_id: id,
      cursor: null,
      terminal: true as const,
    },
  ]);
  terminalCursors.push(
    ...docPageIds.map((id) => ({
      kind: "doc_pages" as const,
      parent_external_id: id,
      cursor: null,
      terminal: true as const,
    })),
  );
  const bytesDeclared = assets.reduce((sum, asset) => sum + (asset.declared_size ?? 0), 0);
  const portable = clickupSidecarSchema.parse({
    sidecar_version: 1,
    manifest_version: 3,
    run_id: job.run_id,
    workspace_id: job.workspace_id,
    snapshot_hash: job.checkpoint?.snapshot_hash,
    mode: job.mode,
    coverage: {
      tasks_expected: taskIds.length,
      tasks_comments_scanned: taskIds.length,
      attachment_parents_scanned: taskIds.length + docPageIds.length,
      terminal_cursors: terminalCursors,
      comments_found: comments.length,
      replies_found: results.reduce((sum, result) => sum + result.replies_found, 0),
      assets_found: assets.length,
      bytes_declared: bytesDeclared,
      bytes_downloaded: results.reduce((sum, result) => sum + result.bytes_downloaded, 0),
      warnings: results.flatMap((result, index) =>
        result.warnings.map((warning) => ({
          ...warning,
          parent_type: (domainParents[index]?.parent_type ?? "task") as "task" | "doc_page",
          parent_external_id: String(domainParents[index]?.external_id ?? "unknown"),
        })),
      ),
      skips: [],
    },
    checkpoint: {
      parent_type: taskIds.length > 0 ? "task" : "doc_page",
      parent_external_id: taskIds.at(-1) ?? docPageIds.at(-1) ?? "empty",
      cursor: null,
      terminal: true,
    },
    comments,
    assets,
  });
  const staged = resolveClickUpSidecarBlobReceipts(portable, receipts);
  await stageClickUpAssetSidecar(db, {
    organizationId: String(job.organization_id),
    userId: String(job.created_by),
    runId: String(job.run_id),
    sidecar: staged as never,
  });
  const { error: completionError } = await db
    .from("clickup_sidecar_collection_jobs")
    .update({
      status: "completed",
      finished_at: new Date().toISOString(),
      checkpoint: {
        ...((job.checkpoint as Record<string, unknown> | null) ?? {}),
        sidecar_staged: true,
      },
    })
    .eq("organization_id", job.organization_id)
    .eq("id", job.id)
    .eq("status", "finalizing");
  if (completionError) throw new Error("clickup_live_finalize_failed");
  return true;
}

export async function runClickUpLiveSidecarWorker(
  db: SupabaseClient,
  workerId = randomUUID(),
  maxParents = 25,
  concurrency = 5,
  deadlineMs = 45_000,
) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + deadlineMs;
  const result = {
    claimed: 0,
    completed: 0,
    retried: 0,
    failed: 0,
    finalized: 0,
    duration_ms: 0,
    remaining: 0,
    eta_minutes: 0,
  };
  let slots = 0;
  const processNext = async (): Promise<void> => {
    if (slots >= maxParents || Date.now() - startedAt >= deadlineMs) return;
    slots += 1;
    const claimed = await claimClickUpLiveSidecarParent(db, workerId);
    if (!claimed) return;
    result.claimed += 1;
    const { job, parent } = claimed;
    const leaseInput = {
      organizationId: String(job.organization_id),
      parentId: String(parent.id),
      claimToken: String(parent.claim_token),
    };
    try {
      const secret = await loadClickUpConnectionSecret(
        db,
        String(job.organization_id),
        String(job.connection_id),
      );
      const token = decryptClickUpToken(secret);
      if (!(await heartbeatClickUpLiveSidecarParent(db, leaseInput))) return;
      const renewLease = async () => {
        if (Date.now() + 5_000 >= deadlineAt) throw new Error("clickup_live_deadline");
        return heartbeatClickUpLiveSidecarParent(db, leaseInput);
      };
      const collected =
        String(parent.parent_type) === "docs_inventory"
          ? await collectDocsInventory(db, job, parent, token, renewLease, deadlineAt)
          : await collectTask(db, job, parent, token, renewLease, deadlineAt);
      if (!(await heartbeatClickUpLiveSidecarParent(db, leaseInput))) return;
      if (
        !(await finishClickUpLiveSidecarParent(db, {
          organizationId: String(job.organization_id),
          parentId: String(parent.id),
          claimToken: String(parent.claim_token),
          outcome: "completed",
          result: collected,
        }))
      )
        return;
      result.completed += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 500) : "Falha na coleta ClickUp.";
      const retry =
        /429|5\d\d|timeout|deadline|network|fetch|upload|connection/i.test(message) &&
        Number(parent.attempts) < Number(parent.max_attempts);
      await finishClickUpLiveSidecarParent(db, {
        organizationId: String(job.organization_id),
        parentId: String(parent.id),
        claimToken: String(parent.claim_token),
        outcome: retry ? "retry_wait" : "failed",
        retryAt: retry
          ? new Date(
              Date.now() + Math.min(60_000, 1_000 * 2 ** Number(parent.attempts)),
            ).toISOString()
          : undefined,
        errorCode: retry
          ? "clickup_live_transient"
          : message.startsWith("clickup_live_")
            ? message
            : "clickup_live_failed",
        errorMessage: message.replace(/https?:\/\/\S+/g, "[url removida]"),
      });
      if (retry) result.retried += 1;
      else result.failed += 1;
    }
    await processNext();
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, 5)) }, () => processNext()),
  );
  if (await finalizeReadyJob(db)) result.finalized += 1;
  const { count } = await db
    .from("clickup_sidecar_collection_parents")
    .select("id", { count: "exact", head: true })
    .in("status", ["queued", "processing", "retry_wait"]);
  result.remaining = count ?? 0;
  result.eta_minutes = Math.ceil(result.remaining / Math.max(1, result.completed));
  result.duration_ms = Date.now() - startedAt;
  return result;
}
