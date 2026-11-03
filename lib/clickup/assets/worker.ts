import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { claimClickUpAsset, finishClickUpAsset, heartbeatClickUpAsset } from "@/lib/clickup/store";

import { applyClickUpAsset } from "./aplicar";

export interface ClickUpAssetWorkerResult {
  claimed: number;
  promoted: number;
  unchanged: number;
  skipped: number;
  conflicts: number;
  failed: number;
  retried: number;
}

export async function runClickUpAssetWorker(
  db: SupabaseClient,
  workerId = randomUUID(),
): Promise<ClickUpAssetWorkerResult> {
  const result = {
    claimed: 0,
    promoted: 0,
    unchanged: 0,
    skipped: 0,
    conflicts: 0,
    failed: 0,
    retried: 0,
  };
  for (let index = 0; index < 25; index += 1) {
    const item = await claimClickUpAsset(db, workerId);
    if (!item) break;
    result.claimed += 1;
    const organizationId = String(item.organization_id);
    const assetId = String(item.id);
    const claimToken = String(item.claim_token);
    if (!(await heartbeatClickUpAsset(db, { organizationId, assetId, claimToken }))) break;
    try {
      const applied = await applyClickUpAsset(db, item, () =>
        heartbeatClickUpAsset(db, { organizationId, assetId, claimToken }),
      );
      const finished = await finishClickUpAsset(db, {
        organizationId,
        assetId,
        claimToken,
        outcome: applied.outcome,
        errorCode: "errorCode" in applied ? applied.errorCode : undefined,
        finalStoragePath: applied.finalPath ?? undefined,
      });
      if (!finished) break;
      result[applied.outcome] += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 500) : "Falha no anexo.";
      if (message === "clickup_asset_lease_lost") break;
      const conflict = /create_only_conflict|sha256_mismatch|size_mismatch|mime_mismatch/.test(
        message,
      );
      const transient =
        /timeout|network|connection|unavailable|quarantine_missing|final_upload|comment_not_applied|parent_not_mapped|cleanup_failed|5\d\d/i.test(
          message,
        );
      const canRetry = transient && Number(item.attempts ?? 0) < Number(item.max_attempts ?? 1);
      await finishClickUpAsset(db, {
        organizationId,
        assetId,
        claimToken,
        outcome: conflict ? "conflict" : canRetry ? "retry_wait" : "failed",
        retryAt: canRetry
          ? new Date(
              Date.now() + Math.min(60_000, 1_000 * 2 ** Number(item.attempts ?? 1)),
            ).toISOString()
          : undefined,
        errorCode: conflict
          ? "asset_mapping_conflict"
          : canRetry
            ? "asset_transient_failure"
            : "asset_apply_failed",
        errorMessage: message,
      });
      if (conflict) result.conflicts += 1;
      else if (canRetry) result.retried += 1;
      else result.failed += 1;
    }
  }
  return result;
}
