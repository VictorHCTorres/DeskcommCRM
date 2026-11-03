import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { ehOperante, STATUS_OPERANTE, statusDaOrgEmbutida } from "@/lib/organizacao/operante";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { gravarTarefa } from "@/lib/tarefas/gravar-tarefa";
import { instanteAposConclusao, instanteDaGeracao } from "@/lib/tarefas/recorrencia";
import type { RecorrenciaDaTarefa, Tarefa } from "@/lib/tarefas/tipos";

export interface ResultadoDaGeracaoRecorrente {
  lidas: number;
  geradas: number;
  puladas: number;
  falhas: number;
}

async function reconciliarConclusoesSemTick(
  db: SupabaseClient,
  agora: Date,
  limite: number,
): Promise<void> {
  const { data, error } = await db
    .from("crm_task_recurrences")
    .select(
      "*, organizations:organization_id!inner(status), current_task:crm_task_recurrences_current_task_fkey!inner(status,updated_at)",
    )
    .eq("active", true)
    .eq("mode", "after_completion")
    .is("next_run_at", null)
    .eq("organizations.status", STATUS_OPERANTE)
    .eq("current_task.status", "done")
    .order("updated_at", { ascending: true })
    .limit(limite);
  if (error) throw new Error(`recurrence_reconcile_query_failed: ${error.message}`);
  for (const bruta of data ?? []) {
    const recorrencia = bruta as unknown as RecorrenciaDaTarefa & {
      organizations?: { status?: string | null } | Array<{ status?: string | null }>;
      current_task?:
        | { status?: string | null; updated_at?: string | null }
        | Array<{ status?: string | null; updated_at?: string | null }>;
    };
    const tarefa = Array.isArray(recorrencia.current_task)
      ? recorrencia.current_task[0]
      : recorrencia.current_task;
    if (
      !ehOperante(statusDaOrgEmbutida(recorrencia.organizations)) ||
      tarefa?.status !== "done" ||
      !tarefa.updated_at ||
      !recorrencia.current_task_id
    )
      continue;
    const prazo = instanteAposConclusao(new Date(tarefa.updated_at), recorrencia).toISOString();
    await db
      .from("crm_task_recurrences")
      .update({ next_run_at: agora.toISOString(), next_due_at: prazo })
      .eq("id", recorrencia.id)
      .eq("organization_id", recorrencia.organization_id)
      .eq("active", true)
      .eq("mode", "after_completion")
      .eq("current_task_id", recorrencia.current_task_id)
      .is("next_run_at", null);
  }
}

async function candidatasOperantes(
  db: SupabaseClient,
  agora: Date,
  limite: number,
): Promise<{ recorrencias: RecorrenciaDaTarefa[]; suspensas: number }> {
  const { data, error } = await db
    .from("crm_task_recurrences")
    .select("*, organizations:organization_id!inner(status)")
    .eq("active", true)
    .lte("next_run_at", agora.toISOString())
    .eq("organizations.status", STATUS_OPERANTE)
    .order("next_run_at", { ascending: true })
    .limit(limite);
  if (error) throw new Error(`recurrence_query_failed: ${error.message}`);
  const recorrencias = (data ?? []).filter((bruta) => {
    const linha = bruta as unknown as {
      organizations?: { status?: string | null } | Array<{ status?: string | null }>;
    };
    return ehOperante(statusDaOrgEmbutida(linha.organizations));
  }) as unknown as RecorrenciaDaTarefa[];
  return { recorrencias, suspensas: (data?.length ?? 0) - recorrencias.length };
}

/**
 * Gera ocorrências com duas travas: UNIQUE da geração e CAS na linha da série.
 * Repetir a rodada ou rodar dois schedulers não cria duas tarefas.
 */
export async function gerarRecorrenciasDeTarefas(
  db: SupabaseClient,
  agora = new Date(),
  limite = 100,
): Promise<ResultadoDaGeracaoRecorrente> {
  const resultado = { lidas: 0, geradas: 0, puladas: 0, falhas: 0 };
  await reconciliarConclusoesSemTick(db, agora, limite);
  const candidatas = await candidatasOperantes(db, agora, limite);
  resultado.puladas += candidatas.suspensas;

  for (const recorrencia of candidatas.recorrencias) {
    resultado.lidas += 1;
    try {
      if (!recorrencia.current_task_id || !recorrencia.next_run_at) {
        resultado.puladas += 1;
        continue;
      }

      const [{ data: atual }, { data: primeira }] = await Promise.all([
        db
          .from("crm_tasks")
          .select("*")
          .eq("id", recorrencia.current_task_id)
          .eq("organization_id", recorrencia.organization_id)
          .maybeSingle(),
        db
          .from("crm_tasks")
          .select("due_date, recurrence_scheduled_for")
          .eq("organization_id", recorrencia.organization_id)
          .eq("recurrence_id", recorrencia.id)
          .eq("recurrence_generation", 0)
          .maybeSingle(),
      ]);
      if (!atual) {
        resultado.puladas += 1;
        continue;
      }

      const tarefaAtual = atual as unknown as Tarefa;
      if (
        tarefaAtual.recurrence_id !== recorrencia.id ||
        tarefaAtual.recurrence_generation !== recorrencia.generation
      ) {
        resultado.puladas += 1;
        logger.warn("[task-recurrence] ponteiro incoerente; série não foi avançada", {
          recurrence_id: recorrencia.id,
          organization_id: recorrencia.organization_id,
        });
        continue;
      }
      const novaGeracao = recorrencia.generation + 1;
      const prazo =
        recorrencia.mode === "after_completion" ? recorrencia.next_due_at : recorrencia.next_run_at;
      if (!prazo) throw new Error("recurrence_due_missing");
      const { tarefa: nova, erro: erroDaCriacao } = await gravarTarefa(db, {
        organization_id: recorrencia.organization_id,
        title: tarefaAtual.title,
        description: tarefaAtual.description,
        due_date: prazo,
        priority: tarefaAtual.priority,
        status: "pending",
        lead_id: tarefaAtual.lead_id,
        contact_id: tarefaAtual.contact_id,
        demanda_id: tarefaAtual.demanda_id,
        assigned_to: tarefaAtual.assigned_to,
        created_by: recorrencia.created_by,
        parent_task_id: null,
        recurrence_id: recorrencia.id,
        recurrence_generation: novaGeracao,
        recurrence_scheduled_for: prazo,
      });

      let tarefaGerada = nova;
      const inseriuNestaRodada = Boolean(nova);
      if (erroDaCriacao?.code === "23505") {
        const { data: existente } = await db
          .from("crm_tasks")
          .select("*")
          .eq("organization_id", recorrencia.organization_id)
          .eq("recurrence_id", recorrencia.id)
          .eq("recurrence_generation", novaGeracao)
          .maybeSingle();
        tarefaGerada = existente as unknown as Tarefa | null;
      } else if (erroDaCriacao) {
        throw new Error(erroDaCriacao.message);
      }
      if (!tarefaGerada) throw new Error("recurrence_task_missing_after_insert");

      const ancora =
        (primeira as { recurrence_scheduled_for?: string | null; due_date?: string | null } | null)
          ?.recurrence_scheduled_for ??
        (primeira as { due_date?: string | null } | null)?.due_date ??
        tarefaAtual.recurrence_scheduled_for ??
        tarefaAtual.due_date;
      const proxima =
        recorrencia.mode === "on_schedule" && ancora
          ? instanteDaGeracao(new Date(ancora), novaGeracao + 1, recorrencia).toISOString()
          : null;
      const { data: ganhou, error: erroCas } = await db
        .from("crm_task_recurrences")
        .update({
          current_task_id: tarefaGerada.id,
          generation: novaGeracao,
          next_run_at: proxima,
          next_due_at: null,
        })
        .eq("id", recorrencia.id)
        .eq("organization_id", recorrencia.organization_id)
        .eq("generation", recorrencia.generation)
        .eq("current_task_id", recorrencia.current_task_id)
        .eq("next_run_at", recorrencia.next_run_at)
        .select("id");
      if (erroCas) throw new Error(erroCas.message);
      if (!ganhou?.length) {
        const { data: serieDepoisDaCorrida } = await db
          .from("crm_task_recurrences")
          .select("current_task_id")
          .eq("id", recorrencia.id)
          .eq("organization_id", recorrencia.organization_id)
          .maybeSingle();
        if (inseriuNestaRodada && serieDepoisDaCorrida?.current_task_id !== tarefaGerada.id) {
          const { error: erroDaLimpeza } = await db
            .from("crm_tasks")
            .delete()
            .eq("id", tarefaGerada.id)
            .eq("organization_id", recorrencia.organization_id)
            .eq("recurrence_id", recorrencia.id)
            .eq("recurrence_generation", novaGeracao);
          if (erroDaLimpeza)
            throw new Error(`recurrence_provisional_cleanup_failed: ${erroDaLimpeza.message}`);
        }
        resultado.puladas += 1;
        continue;
      }

      resultado.geradas += 1;
      await audit({
        action: "crm_task.created",
        organizationId: recorrencia.organization_id,
        resourceType: "crm_tasks",
        resourceId: tarefaGerada.id,
        bypassedRls: true,
        metadata: { origem: "recorrencia", recurrence_id: recorrencia.id, generation: novaGeracao },
      });
      await registraAtividadeDaTarefa(db, {
        organizationId: recorrencia.organization_id,
        tarefa: tarefaGerada,
        tipo: "task_created",
        actor: { type: "webhook_source", id: `task_recurrence:${recorrencia.id}` },
      });
    } catch (falha) {
      resultado.falhas += 1;
      logger.error("[task-recurrence] falha ao gerar ocorrência", {
        recurrence_id: recorrencia.id,
        organization_id: recorrencia.organization_id,
        error: falha instanceof Error ? falha.message : String(falha),
      });
    }
  }
  return resultado;
}
