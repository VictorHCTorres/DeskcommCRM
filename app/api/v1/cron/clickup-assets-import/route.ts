import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { runClickUpAssetWorker } from "@/lib/clickup/assets/worker";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(request))
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  try {
    const db = createAdminClient();
    const result = await runClickUpAssetWorker(db);
    const { data: expired, error } = await db.rpc("fn_expurgar_clickup_asset_staging", {
      p_limite: 500,
    });
    if (error) throw new Error(`clickup_asset_staging_retention:${error.message}`);
    const { data: expiredPreviews, error: previewError } = await db.rpc(
      "fn_expurgar_clickup_preview_staging",
      { p_limite: 25 },
    );
    if (previewError) throw new Error(`clickup_preview_staging_retention:${previewError.message}`);
    const { data: orphans, error: orphanError } = await db.rpc(
      "fn_reconcile_clickup_asset_orphans",
      { p_limite: 500 },
    );
    if (orphanError) throw new Error(`clickup_asset_orphan_reconciliation:${orphanError.message}`);
    return ok(
      {
        ...result,
        expired_staging: Number(expired ?? 0),
        expired_previews: Number(expiredPreviews ?? 0),
        orphan_assets_queued: Number(orphans ?? 0),
      },
      { requestId },
    );
  } catch (error) {
    logger.error("[clickup-assets-import] rodada falhou", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail("internal_error", "Failed to process ClickUp assets.", 500, { requestId });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}
export async function POST(request: NextRequest) {
  return handle(request);
}
