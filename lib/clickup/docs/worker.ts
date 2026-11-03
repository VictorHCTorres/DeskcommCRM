import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  claimClickUpItemForProcessor,
  claimClickUpRunForProcessor,
  finishClickUpItem,
} from "@/lib/clickup/store";

import { aplicarDocClickUp } from "./aplicar";

const TAMANHO_DO_LOTE = 25;

export async function renovarLeaseDoProcessadorDocs(
  db: SupabaseClient,
  input: { runId: string; workerId: string; leaseToken: unknown; checkpoint: unknown },
): Promise<void> {
  const { data, error } = await db.rpc("fn_heartbeat_clickup_import_processor", {
    p_run_id: input.runId,
    p_processor: "docs",
    p_worker_id: input.workerId,
    p_lease_token: input.leaseToken,
    p_checkpoint: input.checkpoint,
    p_lease_seconds: 90,
  });
  if (error) throw new Error(`clickup_docs_heartbeat:${error.message}`);
  if (data !== true) throw new Error("clickup_docs_processor_lease_lost");
}

export async function runClickUpDocsWorker(db: SupabaseClient, workerId = randomUUID()) {
  const resultado = { claimed_run: false, succeeded: 0, skipped: 0, failed: 0 };
  const run = await claimClickUpRunForProcessor(db, workerId, "docs");
  if (!run) return resultado;
  resultado.claimed_run = true;
  const organizationId = String(run.organization_id);
  const runId = String(run.id);

  const heartbeat = () =>
    renovarLeaseDoProcessadorDocs(db, {
      runId,
      workerId,
      leaseToken: run.lease_token,
      checkpoint: { processor: "docs", ...resultado },
    });
  await heartbeat();

  for (let indice = 0; indice < TAMANHO_DO_LOTE; indice += 1) {
    const item = await claimClickUpItemForProcessor(db, organizationId, runId, "docs");
    if (!item) break;
    const itemId = String(item.id);
    const claimToken = String(item.claim_token);
    try {
      const outcome = await aplicarDocClickUp(db, run, item);
      const finalizado = await finishClickUpItem(db, {
        organizationId,
        itemId,
        claimToken,
        outcome,
      });
      if (!finalizado) break;
      resultado[outcome] += 1;
    } catch (erro) {
      await finishClickUpItem(db, {
        organizationId,
        itemId,
        claimToken,
        outcome: "failed",
        errorCode: "clickup_docs_apply_failed",
        errorMessage: erro instanceof Error ? erro.message.slice(0, 500) : "Falha ao importar Doc.",
      });
      resultado.failed += 1;
    }
    await heartbeat();
  }
  return resultado;
}
