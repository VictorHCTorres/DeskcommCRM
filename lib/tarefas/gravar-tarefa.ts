import type { SupabaseClient } from "@supabase/supabase-js";

import type { Tarefa } from "@/lib/tarefas/tipos";

export const COLUNAS_DA_TAREFA =
  "id, organization_id, title, description, due_date, priority, status, lead_id, contact_id, demanda_id, assigned_to, created_by, created_at, updated_at, parent_task_id, recurrence_id, recurrence_generation, recurrence_scheduled_for, tags, start_at, time_estimate_ms, external_id, lead:crm_leads(id, title)";

export type LinhaNovaDeTarefa = Omit<Tarefa, "id" | "created_at" | "updated_at" | "lead">;

/** Única escrita de tarefa usada pela rota humana e pelo gerador recorrente. */
export async function gravarTarefa(
  db: SupabaseClient,
  linha: Partial<LinhaNovaDeTarefa> & Pick<LinhaNovaDeTarefa, "organization_id" | "title">,
): Promise<{
  tarefa: Tarefa | null;
  erro: { code?: string; message: string; details?: string | null } | null;
}> {
  const { data, error } = await db
    .from("crm_tasks")
    .insert(linha as never)
    .select(COLUNAS_DA_TAREFA)
    .single();
  return {
    tarefa: data ? (data as unknown as Tarefa) : null,
    erro: error ? { code: error.code, message: error.message, details: error.details } : null,
  };
}
