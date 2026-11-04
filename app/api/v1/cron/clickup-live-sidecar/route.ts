import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { runClickUpLiveSidecarWorker } from "@/lib/clickup/live-sidecar/worker";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(request))
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  try {
    return ok(await runClickUpLiveSidecarWorker(createAdminClient()), { requestId });
  } catch (error) {
    logger.error("[clickup-live-sidecar] rodada falhou", {
      requestId,
      kind: error instanceof Error ? error.name : "unknown",
    });
    return fail("internal_error", "Failed to collect ClickUp sidecar.", 500, { requestId });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}
export async function POST(request: NextRequest) {
  return handle(request);
}
