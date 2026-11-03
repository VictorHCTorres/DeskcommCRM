import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { runClickUpCrmWorker } from "@/lib/clickup/crm/worker";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

async function handle(request: NextRequest) {
  const requestId = randomUUID();
  if (!autorizaCron(request))
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  try {
    return ok(await runClickUpCrmWorker(createAdminClient()), { requestId });
  } catch (error) {
    logger.error("[clickup-crm-import] rodada falhou", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return fail("internal_error", "Failed to process ClickUp CRM import.", 500, { requestId });
  }
}

export async function GET(request: NextRequest) {
  return handle(request);
}
export async function POST(request: NextRequest) {
  return handle(request);
}
