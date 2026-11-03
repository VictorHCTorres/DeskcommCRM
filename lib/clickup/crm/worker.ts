import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { applyClickUpCrmItem } from "@/lib/clickup/crm/aplicar";
import { CLICKUP_CRM_BATCH_SIZE } from "@/lib/clickup/crm/contrato";
import {
  claimClickUpItemForProcessor,
  claimClickUpRunForProcessor,
  finishClickUpItem,
  heartbeatClickUpItem,
  heartbeatClickUpProcessor,
  markClickUpItemResult,
} from "@/lib/clickup/store";

export interface ClickUpCrmWorkerResult {
  claimed_run: boolean;
  succeeded: number;
  skipped: number;
  unchanged: number;
  validated: number;
  conflicts: number;
  failed: number;
}

export async function runClickUpCrmWorker(
  db: SupabaseClient,
  workerId = randomUUID(),
): Promise<ClickUpCrmWorkerResult> {
  const result = {
    claimed_run: false,
    succeeded: 0,
    skipped: 0,
    unchanged: 0,
    validated: 0,
    conflicts: 0,
    failed: 0,
  };
  const run = await claimClickUpRunForProcessor(db, workerId, "crm");
  if (!run) return result;
  result.claimed_run = true;
  const organizationId = String(run.organization_id);
  const runId = String(run.id);

  for (let index = 0; index < CLICKUP_CRM_BATCH_SIZE; index += 1) {
    const processorAlive = await heartbeatClickUpProcessor(db, {
      runId,
      processor: "crm",
      workerId,
      leaseToken: String(run.lease_token),
      checkpoint: { processor: "crm", index, ...result },
    });
    if (!processorAlive) break;
    const item = await claimClickUpItemForProcessor(db, organizationId, runId, "crm");
    if (!item) break;
    const itemId = String(item.id);
    const claimToken = String(item.claim_token);
    const itemAlive = await heartbeatClickUpItem(db, itemId, claimToken);
    if (!itemAlive) break;
    try {
      const outcome = await applyClickUpCrmItem(db, run, item);
      const resultKind = outcome === "succeeded" ? "created" : outcome;
      if (
        !(await markClickUpItemResult(db, {
          organizationId,
          itemId,
          claimToken,
          resultKind,
        }))
      )
        break;
      const envelopeOutcome =
        outcome === "unchanged" || outcome === "validated" ? "skipped" : outcome;
      const finished = await finishClickUpItem(db, {
        organizationId,
        itemId,
        claimToken,
        outcome: envelopeOutcome,
      });
      if (!finished) break;
      result[outcome] += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 500) : "Falha ao importar item.";
      const transient =
        /timeout|timed out|network|fetch failed|connection|unavailable|ECONN|5\d\d|clickup_parent_.*_(not_applied|not_staged)/i.test(
          message,
        );
      const canRetry = transient && Number(item.attempts ?? 0) < Number(item.max_attempts ?? 1);
      const conflict = message === "clickup_create_only_source_changed";
      if (conflict) {
        await markClickUpItemResult(db, {
          organizationId,
          itemId,
          claimToken,
          resultKind: "conflict",
        });
      }
      await finishClickUpItem(db, {
        organizationId,
        itemId,
        claimToken,
        outcome: canRetry ? "retry_wait" : "failed",
        retryAt: canRetry
          ? new Date(
              Date.now() + Math.min(60_000, 1_000 * 2 ** Number(item.attempts ?? 1)),
            ).toISOString()
          : undefined,
        errorCode: conflict ? "mapping_conflict" : "clickup_crm_apply_failed",
        errorMessage: message,
      });
      if (conflict) result.conflicts += 1;
      else if (!canRetry) result.failed += 1;
    }
  }

  await heartbeatClickUpProcessor(db, {
    runId,
    processor: "crm",
    workerId,
    leaseToken: String(run.lease_token),
    checkpoint: { processor: "crm", ...result },
  });
  return result;
}
