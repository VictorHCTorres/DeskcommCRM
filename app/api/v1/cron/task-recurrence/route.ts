import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { autorizaCron } from "@/lib/auth/cron-auth";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { gerarRecorrenciasDeTarefas } from "@/lib/tarefas/gerar-recorrencia";

export const dynamic = "force-dynamic";

async function handle(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  if (!autorizaCron(req)) {
    return fail("forbidden", "Cron secret missing or invalid.", 403, { requestId });
  }
  try {
    const resultado = await gerarRecorrenciasDeTarefas(
      createAdminClient() as unknown as SupabaseClient,
      new Date(),
      100,
    );
    if (resultado.geradas > 0 || resultado.falhas > 0) {
      await audit({
        action: "crm_task.updated",
        organizationId: null,
        resourceType: "crm_task_recurrences",
        requestId,
        bypassedRls: true,
        metadata: resultado as unknown as Record<string, unknown>,
      });
    }
    return ok(resultado, { requestId });
  } catch (falha) {
    logger.error("[task-recurrence] rodada falhou", {
      requestId,
      error: falha instanceof Error ? falha.message : String(falha),
    });
    return fail("internal_error", "Failed to generate recurring tasks.", 500, { requestId });
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req);
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req);
}
