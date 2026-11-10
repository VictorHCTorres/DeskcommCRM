import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { catalogoClickUpDasTarefas } from "@/lib/tarefas/origem-clickup";

export const dynamic = "force-dynamic";

/** Só lista coleções que já têm tarefa de destino no CRM, nunca o staging. */
export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const db = await createClient();
  const metadados: unknown[] = [];
  for (let from = 0; from < 100_000; from += 1_000) {
    const { data, error } = await db
      .from("crm_tasks")
      .select("source_metadata")
      .eq("organization_id", authz.org.orgId)
      .not("source_metadata", "is", null)
      .order("id", { ascending: true })
      .range(from, from + 999);
    if (error) {
      return fail("internal_error", "Erro ao listar as coleções do ClickUp.", 500, {
        requestId,
      });
    }
    metadados.push(...(data ?? []).map((row) => row.source_metadata));
    if ((data ?? []).length < 1_000) break;
  }
  return ok({ collections: catalogoClickUpDasTarefas(metadados) }, { requestId });
}
