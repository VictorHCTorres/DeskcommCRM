import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONTACT_1,
  GOV_LEAD,
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const OUTRA_ORG = "90920000-0000-4000-8000-000000000001";
const OUTRO_PIPE = "90920000-0000-4000-8000-000000000002";
const OUTRO_STAGE = "90920000-0000-4000-8000-000000000003";
const OUTRO_CONTATO = "90920000-0000-4000-8000-000000000004";
const OUTRO_LEAD = "90920000-0000-4000-8000-000000000005";
const VIEW_PESSOAL = "90920000-0000-4000-8000-000000000010";
const VIEW_COMPARTILHADA = "90920000-0000-4000-8000-000000000011";
const VIEW_OUTRA = "90920000-0000-4000-8000-000000000012";
const TAREFA_RAIZ = "90930000-0000-4000-8000-000000000010";
const SUBTAREFA = "90930000-0000-4000-8000-000000000011";
const PAI_OCULTO = "90930000-0000-4000-8000-000000000012";
const FILHA_VISIVEL = "90930000-0000-4000-8000-000000000013";
const RECORRENCIA = "90930000-0000-4000-8000-000000000020";
const RECORRENCIA_APOS_CONCLUIR = "90930000-0000-4000-8000-000000000021";
const ORG_PURGE = "90930000-0000-4000-8000-000000000030";
const RECORRENCIA_PURGE = "90930000-0000-4000-8000-000000000031";

describe("W2 — visualizações salvas e envelope de tarefas", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${OUTRA_ORG}', 'w2-outra', 'W2 Outra', 'W2 Outra') on conflict do nothing;
      insert into public.crm_pipelines (id, organization_id, name, slug, position)
        values ('${OUTRO_PIPE}', '${OUTRA_ORG}', 'Funil externo W2', 'funil-externo-w2', 1)
        on conflict do nothing;
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
        values ('${OUTRO_STAGE}', '${OUTRA_ORG}', '${OUTRO_PIPE}', 'Nova', 'nova', 1)
        on conflict do nothing;
      insert into public.contacts (id, organization_id, display_name)
        values ('${OUTRO_CONTATO}', '${OUTRA_ORG}', 'Contato externo W2') on conflict do nothing;
      insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
        values ('${OUTRO_LEAD}', '${OUTRA_ORG}', '${OUTRO_PIPE}', '${OUTRO_STAGE}', 'Lead externo W2')
        on conflict do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values
          ('${GOV_AGENT_A}', '${OUTRA_ORG}', 'agent', now()),
          ('${GOV_AGENT_B}', '${OUTRA_ORG}', 'agent', now()),
          ('${GOV_MANAGER}', '${OUTRA_ORG}', 'manager', now())
        on conflict do nothing;
      update public.organizations
        set settings = settings || '{"visibility_mode":"own","colegas_podem_mexer_na_agenda":false}'::jsonb
        where id = '${OUTRA_ORG}';
      insert into public.crm_pipeline_views
        (id, organization_id, pipeline_id, owner_user_id, created_by, name, visibility)
        values ('${VIEW_OUTRA}', '${OUTRA_ORG}', '${OUTRO_PIPE}', '${GOV_VIEWER}', '${GOV_VIEWER}',
          'Privada externa', 'personal') on conflict do nothing;
    `);
  });

  it("isola visualizações e permite ler apenas as compartilhadas ou próprias da organização", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `insert into public.crm_pipeline_views
          (id, organization_id, pipeline_id, owner_user_id, created_by, name, visibility)
         values ('${VIEW_PESSOAL}', '${GOV_ORG}', '${GOV_PIPELINE}', '${GOV_VIEWER}',
          '${GOV_VIEWER}', 'Minha visão W2', 'personal')`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.crm_pipeline_views
          (id, organization_id, pipeline_id, owner_user_id, created_by, name, visibility)
         values ('${VIEW_COMPARTILHADA}', '${GOV_ORG}', '${GOV_PIPELINE}', null,
          '${GOV_MANAGER}', 'Equipe W2', 'shared')`,
      ),
    ).toBe(1);
    expect(
      countAs(
        GOV_VIEWER,
        `select count(*) from public.crm_pipeline_views
          where id in ('${VIEW_PESSOAL}', '${VIEW_COMPARTILHADA}', '${VIEW_OUTRA}');`,
      ),
    ).toBe(2);
  });

  it("viewer não cria compartilhada e formato personal/shared é obrigatório", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `insert into public.crm_pipeline_views
          (organization_id, pipeline_id, owner_user_id, created_by, name, visibility)
         values ('${GOV_ORG}', '${GOV_PIPELINE}', null, '${GOV_VIEWER}',
          'Compartilhada negada W2', 'shared')`,
      ),
    ).toBe(0);
    expect(() =>
      sql(`insert into public.crm_pipeline_views
        (organization_id, pipeline_id, owner_user_id, created_by, name, visibility)
       values ('${GOV_ORG}', '${GOV_PIPELINE}', null, '${GOV_VIEWER}', 'Pessoal inválida W2', 'personal');`),
    ).toThrow();
  });

  it("não vincula visualização a funil de outra organização e anon não recebe privilégios", () => {
    expect(() =>
      sql(`insert into public.crm_pipeline_views
        (organization_id, pipeline_id, owner_user_id, created_by, name, visibility)
       values ('${GOV_ORG}', '${OUTRO_PIPE}', '${GOV_VIEWER}', '${GOV_VIEWER}',
        'Funil cruzado W2', 'personal');`),
    ).toThrow();
    expect(
      sql(`select count(*) from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'crm_pipeline_views'
          and grantee in ('PUBLIC', 'anon');`),
    ).toBe("0");
  });

  it("subtarefa herda contexto, não aceita neta e apagar pai promove a filha", () => {
    sql(`
      insert into public.crm_tasks
        (id, organization_id, title, lead_id, contact_id, created_by)
      values ('${TAREFA_RAIZ}', '${GOV_ORG}', 'Raiz W2', '${GOV_LEAD}', '${GOV_CONTACT_1}', '${GOV_MANAGER}')
      on conflict do nothing;
      insert into public.crm_tasks
        (id, organization_id, title, parent_task_id, created_by)
      values ('${SUBTAREFA}', '${GOV_ORG}', 'Filha W2', '${TAREFA_RAIZ}', '${GOV_MANAGER}')
      on conflict do nothing;
    `);
    expect(
      sql(`select (lead_id = '${GOV_LEAD}')::text || ':' ||
        (contact_id = '${GOV_CONTACT_1}')::text from public.crm_tasks where id = '${SUBTAREFA}';`),
    ).toBe("true:true");
    expect(() =>
      sql(`insert into public.crm_tasks (organization_id, title, parent_task_id)
        values ('${GOV_ORG}', 'Neta W2', '${SUBTAREFA}');`),
    ).toThrow();
    expect(() =>
      sql(`update public.crm_tasks set parent_task_id = null where id = '${SUBTAREFA}';`),
    ).toThrow();
    sql(`delete from public.crm_tasks where id = '${TAREFA_RAIZ}';`);
    expect(
      sql(`select parent_task_id is null from public.crm_tasks where id = '${SUBTAREFA}';`),
    ).toBe("t");
  });

  it("tarefa não aceita lead ou contato de outra organização", () => {
    expect(() =>
      sql(`insert into public.crm_tasks (organization_id, title, lead_id)
        values ('${GOV_ORG}', 'Lead cruzado W2', '${OUTRO_LEAD}');`),
    ).toThrow();
    expect(() =>
      sql(`insert into public.crm_tasks (organization_id, title, contact_id)
        values ('${GOV_ORG}', 'Contato cruzado W2', '${OUTRO_CONTATO}');`),
    ).toThrow();
    expect(
      sql(`select count(*) from pg_constraint where conname in
        ('crm_tasks_lead_org_fkey', 'crm_tasks_contact_org_fkey');`),
    ).toBe("2");
  });

  it("pai oculto por RLS não é confundido com pai apagado ao promover a filha", () => {
    sql(`insert into public.crm_tasks
      (id, organization_id, title, assigned_to, created_by)
      values ('${PAI_OCULTO}', '${OUTRA_ORG}', 'Pai oculto W2', '${GOV_AGENT_B}', '${GOV_AGENT_B}');
      insert into public.crm_tasks
      (id, organization_id, title, parent_task_id, assigned_to, created_by)
      values ('${FILHA_VISIVEL}', '${OUTRA_ORG}', 'Filha visível W2', '${PAI_OCULTO}',
        '${GOV_AGENT_A}', '${GOV_AGENT_A}');`);
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.crm_tasks where id in ('${PAI_OCULTO}', '${FILHA_VISIVEL}');`,
      ),
    ).toBe(1);
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', false);
        insert into public.crm_tasks
          (organization_id, title, parent_task_id, assigned_to, created_by)
        values ('${OUTRA_ORG}', 'Outra filha W2', '${PAI_OCULTO}', '${GOV_AGENT_A}',
          '${GOV_AGENT_A}');`),
    ).toThrow();
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.crm_tasks
          (organization_id, title, parent_task_id, assigned_to, created_by)
        values ('${OUTRA_ORG}', 'Filha da gerente W2', '${PAI_OCULTO}', '${GOV_MANAGER}',
          '${GOV_MANAGER}')`,
      ),
    ).toBe(1);
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', false);
        update public.crm_tasks set parent_task_id = null where id = '${FILHA_VISIVEL}';`),
    ).toThrow();
    expect(
      sql(`select parent_task_id::text from public.crm_tasks where id = '${FILHA_VISIVEL}';`),
    ).toBe(PAI_OCULTO);
  });

  it("recorrência pertence à organização, gera uma tarefa por geração e só em raiz", () => {
    sql(`insert into public.crm_task_recurrences
      (id, organization_id, frequency, interval, mode, timezone, generation, active, created_by)
      values ('${RECORRENCIA}', '${GOV_ORG}', 'weekly', 2, 'on_schedule', 'America/Fortaleza', 0,
        false, '${GOV_MANAGER}') on conflict do nothing;`);
    expect(() =>
      sql(`insert into public.crm_tasks
        (organization_id, title, parent_task_id, recurrence_id, recurrence_generation)
       values ('${GOV_ORG}', 'Filha recorrente W2', '${SUBTAREFA}', '${RECORRENCIA}', 1);`),
    ).toThrow();
    sql(`insert into public.crm_tasks
      (organization_id, title, recurrence_id, recurrence_generation, recurrence_scheduled_for)
      values ('${GOV_ORG}', 'Recorrente W2', '${RECORRENCIA}', 1, now());`);
    expect(() =>
      sql(`insert into public.crm_tasks
        (organization_id, title, recurrence_id, recurrence_generation, recurrence_scheduled_for)
       values ('${GOV_ORG}', 'Recorrente duplicada W2', '${RECORRENCIA}', 1, now());`),
    ).toThrow();
    expect(
      sql(`select count(*) from pg_indexes where schemaname = 'public'
        and indexname = 'crm_task_recurrences_active_current_uidx';`),
    ).toBe("1");
  });

  it("série ativa aponta para ocorrência coerente, protege a corrente e não pode ser apagada", () => {
    const corrente = sql(`select id from public.crm_tasks
      where organization_id = '${GOV_ORG}' and recurrence_id = '${RECORRENCIA}'
        and recurrence_generation = 1 limit 1;`);
    sql(`update public.crm_task_recurrences
      set current_task_id = '${corrente}', generation = 1, active = true, next_run_at = now()
      where id = '${RECORRENCIA}';`);
    expect(() => sql(`delete from public.crm_tasks where id = '${corrente}';`)).toThrow();
    expect(
      sql(`select has_table_privilege('authenticated', 'public.crm_task_recurrences', 'DELETE')::text
        || ':' || has_table_privilege('service_role', 'public.crm_task_recurrences', 'DELETE')::text;`),
    ).toBe("false:false");
  });

  it("after_completion separa execução imediata do prazo futuro e on_schedule não usa next_due_at", () => {
    sql(`insert into public.crm_task_recurrences
      (id, organization_id, frequency, mode, active, created_by)
      values ('${RECORRENCIA_APOS_CONCLUIR}', '${GOV_ORG}', 'daily', 'after_completion', false,
        '${GOV_MANAGER}');
      insert into public.crm_tasks
        (organization_id, title, recurrence_id, recurrence_generation, recurrence_scheduled_for)
      values ('${GOV_ORG}', 'Após concluir W2', '${RECORRENCIA_APOS_CONCLUIR}', 1, now());`);
    const corrente = sql(`select id from public.crm_tasks
      where organization_id = '${GOV_ORG}' and recurrence_id = '${RECORRENCIA_APOS_CONCLUIR}';`);
    sql(`update public.crm_task_recurrences set current_task_id = '${corrente}', generation = 1,
      active = true, next_run_at = null, next_due_at = null
      where id = '${RECORRENCIA_APOS_CONCLUIR}';`);
    expect(() =>
      sql(`update public.crm_task_recurrences set next_run_at = now(), next_due_at = null
        where id = '${RECORRENCIA_APOS_CONCLUIR}';`),
    ).toThrow();
    sql(`update public.crm_task_recurrences set current_task_id = '${corrente}', generation = 1,
      active = true, next_run_at = now(), next_due_at = now() + interval '1 day'
      where id = '${RECORRENCIA_APOS_CONCLUIR}';`);
    sql(`insert into public.crm_tasks
      (organization_id, title, recurrence_id, recurrence_generation, recurrence_scheduled_for)
      values ('${GOV_ORG}', 'Após concluir W2 — N+1', '${RECORRENCIA_APOS_CONCLUIR}', 2,
        now() + interval '1 day');`);
    const proxima = sql(`select id from public.crm_tasks
      where organization_id = '${GOV_ORG}' and recurrence_id = '${RECORRENCIA_APOS_CONCLUIR}'
        and recurrence_generation = 2;`);
    sql(`update public.crm_task_recurrences set current_task_id = '${proxima}', generation = 2,
      next_run_at = null, next_due_at = null where id = '${RECORRENCIA_APOS_CONCLUIR}';`);
    expect(
      sql(`select (next_run_at is null and next_due_at is null)::text
        from public.crm_task_recurrences where id = '${RECORRENCIA_APOS_CONCLUIR}';`),
    ).toBe("true");
    expect(() =>
      sql(`update public.crm_task_recurrences set mode = 'on_schedule'
        where id = '${RECORRENCIA_APOS_CONCLUIR}';`),
    ).toThrow();
    expect(() =>
      sql(`update public.crm_task_recurrences set mode = 'on_schedule', next_run_at = now(),
        next_due_at = now() + interval '1 day' where id = '${RECORRENCIA_APOS_CONCLUIR}';`),
    ).toThrow();
    expect(
      sql(`select count(*) from pg_indexes where schemaname = 'public'
        and indexname = 'crm_task_recurrences_next_due_idx';`),
    ).toBe("1");
  });

  it("viewer não escreve recorrência; agent escreve dentro da própria organização", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `insert into public.crm_task_recurrences
          (organization_id, frequency, interval, mode, timezone, created_by)
         values ('${GOV_ORG}', 'daily', 1, 'on_schedule', 'UTC', '${GOV_VIEWER}')`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.crm_task_recurrences
          (organization_id, frequency, interval, mode, timezone, active, created_by)
         values ('${GOV_ORG}', 'monthly', 1, 'after_completion', 'UTC', false, '${GOV_AGENT_A}')`,
      ),
    ).toBe(1);
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.crm_task_recurrences
          where organization_id = '${GOV_ORG}' and created_by = '${GOV_AGENT_A}';`,
      ),
    ).toBe(1);
    expect(
      countAs(
        GOV_AGENT_B,
        `select count(*) from public.crm_task_recurrences
          where organization_id = '${GOV_ORG}' and created_by = '${GOV_AGENT_A}';`,
      ),
    ).toBe(1);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `update public.crm_task_recurrences set interval = 2
          where organization_id = '${GOV_ORG}' and created_by = '${GOV_AGENT_A}'`,
      ),
    ).toBe(1);
  });

  it("purge da organização remove série ativa e histórico sem estado parcial", () => {
    sql(`insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_PURGE}', 'w2-purge', 'W2 Purge', 'W2 Purge');
      insert into public.crm_task_recurrences
        (id, organization_id, frequency, mode, active)
      values ('${RECORRENCIA_PURGE}', '${ORG_PURGE}', 'daily', 'on_schedule', false);
      insert into public.crm_tasks
        (organization_id, title, recurrence_id, recurrence_generation, recurrence_scheduled_for)
      values
        ('${ORG_PURGE}', 'Histórico W2', '${RECORRENCIA_PURGE}', 1, now() - interval '1 day'),
        ('${ORG_PURGE}', 'Corrente W2', '${RECORRENCIA_PURGE}', 2, now());`);
    const corrente = sql(`select id from public.crm_tasks where organization_id = '${ORG_PURGE}'
      and recurrence_id = '${RECORRENCIA_PURGE}' and recurrence_generation = 2;`);
    sql(`update public.crm_task_recurrences set active = true, current_task_id = '${corrente}',
      generation = 2, next_run_at = now() where id = '${RECORRENCIA_PURGE}';`);

    sql(`delete from public.organizations where id = '${ORG_PURGE}';`);

    expect(
      sql(`select
        (select count(*) from public.organizations where id = '${ORG_PURGE}')::text || ':' ||
        (select count(*) from public.crm_tasks where organization_id = '${ORG_PURGE}')::text || ':' ||
        (select count(*) from public.crm_task_recurrences where organization_id = '${ORG_PURGE}')::text;`),
    ).toBe("0:0:0");
  });
});
