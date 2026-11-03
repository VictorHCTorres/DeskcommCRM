import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { instanteDaGeracao } from "@/lib/tarefas/recorrencia";
import { FREQUENCIAS_DA_RECORRENCIA, MODOS_DA_RECORRENCIA } from "@/lib/tarefas/tipos";
import { fusoUtilizavel } from "@/lib/tempo/fusos";

export const dynamic = "force-dynamic";

const schema = z.object({
  frequency: z.enum(FREQUENCIAS_DA_RECORRENCIA),
  interval: z.number().int().min(1).max(365).default(1),
  mode: z.enum(MODOS_DA_RECORRENCIA),
  // Compatibilidade com clientes antigos; a autoridade é a organização.
  timezone: z.string().trim().max(100).optional(),
});

interface Contexto {
  params: Promise<{ id: string }>;
}

export async function PUT(req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success)
    return fail("validation_failed", "Configuração inválida.", 422, { requestId });

  const { id } = await ctx.params;
  const agoraDoRequest = new Date();
  const supabase = await createClient();
  const db = supabase as unknown as SupabaseClient;
  const { data: organizacao, error: erroDaOrganizacao } = await db
    .from("organizations")
    .select("timezone")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (erroDaOrganizacao)
    return fail("internal_error", "Erro ao configurar a recorrência.", 500, { requestId });
  const configuracao = {
    ...parsed.data,
    timezone: fusoUtilizavel((organizacao as { timezone?: string | null } | null)?.timezone),
  };
  const { data: linha, error } = await db
    .from("crm_tasks")
    .select(
      "id, parent_task_id, recurrence_id, recurrence_generation, recurrence_scheduled_for, due_date",
    )
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao configurar a recorrência.", 500, { requestId });
  if (!linha) return fail("not_found", "Tarefa não encontrada.", 404, { requestId });
  if (linha.parent_task_id) {
    return fail("state_conflict", "Somente tarefas principais podem ser recorrentes.", 409, {
      requestId,
    });
  }
  let ancoraConfigurada = linha.recurrence_scheduled_for ?? linha.due_date;
  if (linha.recurrence_id) {
    const { data: primeira } = await db
      .from("crm_tasks")
      .select("recurrence_scheduled_for, due_date")
      .eq("organization_id", authz.org.orgId)
      .eq("recurrence_id", linha.recurrence_id)
      .eq("recurrence_generation", 0)
      .maybeSingle();
    ancoraConfigurada =
      primeira?.recurrence_scheduled_for ?? primeira?.due_date ?? ancoraConfigurada;
  }
  if (configuracao.mode === "on_schedule" && !ancoraConfigurada) {
    return fail("validation_failed", "Defina um prazo antes de agendar a recorrência.", 422, {
      requestId,
    });
  }
  const ancoraBruta = ancoraConfigurada ?? agoraDoRequest.toISOString();
  const proxima =
    configuracao.mode === "on_schedule"
      ? instanteDaGeracao(
          new Date(ancoraBruta),
          (linha.recurrence_generation ?? 0) + 1,
          configuracao,
        ).toISOString()
      : null;

  let recurrenceId = linha.recurrence_id as string | null;
  if (recurrenceId) {
    const { data: versao } = await db
      .from("crm_task_recurrences")
      .select("updated_at, current_task_id, generation, active, created_by")
      .eq("id", recurrenceId)
      .eq("organization_id", authz.org.orgId)
      .maybeSingle();
    if (!versao)
      return fail("state_conflict", "A série mudou enquanto era editada. Tente novamente.", 409, {
        requestId,
      });
    const geracaoDaTarefa = linha.recurrence_generation ?? 0;
    const serieCorrente = versao.current_task_id === id && versao.generation === geracaoDaTarefa;
    const seriePendenteDoUsuario =
      versao.current_task_id === null &&
      versao.active === false &&
      versao.created_by === authz.user.id &&
      versao.generation === geracaoDaTarefa;
    if (!serieCorrente && !seriePendenteDoUsuario) {
      return fail("state_conflict", "Somente a ocorrência atual pode configurar a série.", 409, {
        requestId,
      });
    }
    let atualizacao = db
      .from("crm_task_recurrences")
      .update({
        ...configuracao,
        current_task_id: id,
        generation: geracaoDaTarefa,
        next_run_at: proxima,
        next_due_at: null,
        active: true,
      })
      .eq("id", recurrenceId)
      .eq("organization_id", authz.org.orgId)
      .eq("updated_at", versao.updated_at);
    if (seriePendenteDoUsuario) {
      atualizacao = atualizacao
        .eq("created_by", authz.user.id)
        .is("current_task_id", null)
        .eq("active", false)
        .eq("generation", geracaoDaTarefa);
    } else {
      atualizacao = atualizacao.eq("current_task_id", id).eq("generation", geracaoDaTarefa);
    }
    const { data: atualizada, error: updateError } = await atualizacao.select("id");
    if (updateError)
      return fail("internal_error", "Erro ao configurar a recorrência.", 500, { requestId });
    if (!atualizada?.length)
      return fail("state_conflict", "A série mudou enquanto era editada. Tente novamente.", 409, {
        requestId,
      });
  } else {
    const { data: criada, error: insertError } = await db
      .from("crm_task_recurrences")
      .insert({
        organization_id: authz.org.orgId,
        ...configuracao,
        current_task_id: null,
        next_run_at: null,
        next_due_at: null,
        generation: 0,
        active: false,
        created_by: authz.user.id,
      })
      .select("id")
      .single();
    if (insertError || !criada)
      return fail("internal_error", "Erro ao configurar a recorrência.", 500, { requestId });
    recurrenceId = criada.id as string;
    const { data: tarefaAtualizada, error: taskError } = await db
      .from("crm_tasks")
      .update({
        recurrence_id: recurrenceId,
        recurrence_generation: 0,
        recurrence_scheduled_for: ancoraBruta,
      })
      .eq("id", id)
      .eq("organization_id", authz.org.orgId)
      .is("recurrence_id", null)
      .select("id");
    if (taskError || !tarefaAtualizada?.length) {
      // Compensação recuperável: histórico nunca é apagado. A série perdedora
      // fica inativa e sem tick; o PUT concorrente vencedor permanece ligado.
      await db
        .from("crm_task_recurrences")
        .update({ active: false, next_run_at: null })
        .eq("id", recurrenceId)
        .eq("organization_id", authz.org.orgId);
      if (!taskError)
        return fail("state_conflict", "A tarefa ganhou outra série ao mesmo tempo.", 409, {
          requestId,
        });
      return fail("internal_error", "Erro ao configurar a recorrência.", 500, { requestId });
    }

    const { data: serieAtivada, error: activateError } = await db
      .from("crm_task_recurrences")
      .update({
        current_task_id: id,
        generation: 0,
        next_run_at: proxima,
        next_due_at: null,
        active: true,
      })
      .eq("id", recurrenceId)
      .eq("organization_id", authz.org.orgId)
      .eq("created_by", authz.user.id)
      .is("current_task_id", null)
      .eq("active", false)
      .select("id");
    if (activateError || !serieAtivada?.length) {
      // O vínculo da tarefa pode ter vencido, mas a série não entra no motor
      // sem o CAS final. Assim o constraint deferred nunca vê pontas divergentes.
      if (!activateError)
        return fail("state_conflict", "A série mudou enquanto era ativada. Tente novamente.", 409, {
          requestId,
        });
      return fail("internal_error", "Erro ao configurar a recorrência.", 500, { requestId });
    }
  }

  await audit({
    action: "crm_task.updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "crm_task_recurrence",
    resourceId: recurrenceId,
    requestId,
    metadata: { operacao: "recorrencia_configurada", ...configuracao },
  });
  return ok({ recurrence_id: recurrenceId, next_run_at: proxima }, { requestId });
}

export async function DELETE(_req: NextRequest, ctx: Contexto): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "crm_tasks" });
  if (!authz.ok) return authz.response;
  const { id } = await ctx.params;
  const db = (await createClient()) as unknown as SupabaseClient;
  const { data: tarefa } = await db
    .from("crm_tasks")
    .select("recurrence_id")
    .eq("id", id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!tarefa) return fail("not_found", "Tarefa não encontrada.", 404, { requestId });
  if (!tarefa.recurrence_id) return ok({ cancelled: true }, { requestId });

  const { data: serie } = await db
    .from("crm_task_recurrences")
    .select("id, active, current_task_id, updated_at")
    .eq("id", tarefa.recurrence_id)
    .eq("organization_id", authz.org.orgId)
    .maybeSingle();
  if (!serie) return fail("not_found", "Série recorrente não encontrada.", 404, { requestId });
  if (!serie.active || serie.current_task_id !== id) {
    return fail("state_conflict", "A série mudou enquanto era cancelada. Tente novamente.", 409, {
      requestId,
    });
  }
  const { data: cancelada, error } = await db
    .from("crm_task_recurrences")
    .update({ active: false, next_run_at: null, next_due_at: null })
    .eq("id", tarefa.recurrence_id)
    .eq("organization_id", authz.org.orgId)
    .eq("current_task_id", id)
    .eq("active", true)
    .eq("updated_at", serie.updated_at)
    .select("id");
  if (error) return fail("internal_error", "Erro ao cancelar a recorrência.", 500, { requestId });
  if (!cancelada?.length) {
    return fail("state_conflict", "A série mudou enquanto era cancelada. Tente novamente.", 409, {
      requestId,
    });
  }
  await audit({
    action: "crm_task.updated",
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    resourceType: "crm_task_recurrence",
    resourceId: tarefa.recurrence_id as string,
    requestId,
    metadata: { operacao: "recorrencia_cancelada" },
  });
  return ok({ cancelled: true }, { requestId });
}
