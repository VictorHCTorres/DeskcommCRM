-- manifest: Prepara tarefas para hierarquia rasa e recorrência determinística, mantendo contexto de organização, negócio, contato e demanda coerente entre tarefa pai e subtarefa.

create unique index if not exists crm_tasks_org_id_uidx
  on public.crm_tasks (organization_id, id);
create unique index if not exists crm_leads_org_id_uidx
  on public.crm_leads (organization_id, id);
create unique index if not exists contacts_org_id_uidx
  on public.contacts (organization_id, id);

alter table public.crm_tasks
  add column if not exists parent_task_id uuid,
  add column if not exists recurrence_id uuid,
  add column if not exists recurrence_generation integer not null default 0,
  add column if not exists recurrence_scheduled_for timestamptz;

alter table public.crm_tasks drop constraint if exists crm_tasks_parent_not_self;
alter table public.crm_tasks add constraint crm_tasks_parent_not_self
  check (parent_task_id is null or parent_task_id <> id);
alter table public.crm_tasks drop constraint if exists crm_tasks_recurrence_generation_check;
alter table public.crm_tasks add constraint crm_tasks_recurrence_generation_check
  check (recurrence_generation >= 0);
alter table public.crm_tasks drop constraint if exists crm_tasks_recurrence_root_only;
alter table public.crm_tasks add constraint crm_tasks_recurrence_root_only
  check (parent_task_id is null or recurrence_id is null);
alter table public.crm_tasks drop constraint if exists crm_tasks_recurrence_shape;
alter table public.crm_tasks add constraint crm_tasks_recurrence_shape check (
  (recurrence_id is null and recurrence_generation = 0 and recurrence_scheduled_for is null)
  or (recurrence_id is not null and parent_task_id is null and recurrence_scheduled_for is not null)
);
alter table public.crm_tasks drop constraint if exists crm_tasks_parent_fkey;
alter table public.crm_tasks add constraint crm_tasks_parent_fkey
  foreign key (organization_id, parent_task_id)
  references public.crm_tasks (organization_id, id)
  on delete set null (parent_task_id);
alter table public.crm_tasks drop constraint if exists crm_tasks_lead_id_fkey;
alter table public.crm_tasks drop constraint if exists crm_tasks_lead_org_fkey;
alter table public.crm_tasks add constraint crm_tasks_lead_org_fkey
  foreign key (organization_id, lead_id)
  references public.crm_leads (organization_id, id)
  on delete set null (lead_id);
alter table public.crm_tasks drop constraint if exists crm_tasks_contact_id_fkey;
alter table public.crm_tasks drop constraint if exists crm_tasks_contact_org_fkey;
alter table public.crm_tasks add constraint crm_tasks_contact_org_fkey
  foreign key (organization_id, contact_id)
  references public.contacts (organization_id, id)
  on delete set null (contact_id);

create index if not exists crm_tasks_org_parent_idx
  on public.crm_tasks (organization_id, parent_task_id, created_at)
  where parent_task_id is not null;

create table if not exists public.crm_task_recurrences (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  current_task_id uuid,
  frequency text not null,
  interval integer not null default 1,
  mode text not null default 'on_schedule',
  timezone text not null default 'UTC',
  next_run_at timestamptz,
  next_due_at timestamptz,
  generation integer not null default 0,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_task_recurrences_org_id_key unique (organization_id, id),
  constraint crm_task_recurrences_frequency_check check (frequency in ('daily', 'weekly', 'monthly')),
  constraint crm_task_recurrences_interval_check check (interval > 0),
  constraint crm_task_recurrences_mode_check check (mode in ('on_schedule', 'after_completion')),
  constraint crm_task_recurrences_generation_check check (generation >= 0),
  constraint crm_task_recurrences_timezone_check check (char_length(btrim(timezone)) between 1 and 100)
);

alter table public.crm_task_recurrences add column if not exists next_due_at timestamptz;
alter table public.crm_task_recurrences
  drop constraint if exists crm_task_recurrences_due_shape;
alter table public.crm_task_recurrences
  add constraint crm_task_recurrences_due_shape check (
    (mode = 'on_schedule' and next_due_at is null)
    or (mode = 'after_completion' and (
      (next_run_at is null and next_due_at is null)
      or (next_run_at is not null and next_due_at is not null and next_due_at > next_run_at)
    ))
  );

alter table public.crm_tasks drop constraint if exists crm_tasks_recurrence_fkey;
alter table public.crm_tasks add constraint crm_tasks_recurrence_fkey
  foreign key (organization_id, recurrence_id)
  references public.crm_task_recurrences (organization_id, id)
  on delete restrict;
alter table public.crm_task_recurrences drop constraint if exists crm_task_recurrences_current_task_fkey;
alter table public.crm_task_recurrences add constraint crm_task_recurrences_current_task_fkey
  foreign key (organization_id, current_task_id)
  references public.crm_tasks (organization_id, id)
  on delete set null (current_task_id);

create unique index if not exists crm_tasks_recurrence_generation_uidx
  on public.crm_tasks (organization_id, recurrence_id, recurrence_generation)
  where recurrence_id is not null;
create index if not exists crm_task_recurrences_due_idx
  on public.crm_task_recurrences (organization_id, active, next_run_at)
  where active = true;
create index if not exists crm_task_recurrences_next_due_idx
  on public.crm_task_recurrences (organization_id, next_due_at)
  where active = true and mode = 'after_completion';
create unique index if not exists crm_task_recurrences_active_current_uidx
  on public.crm_task_recurrences (organization_id, current_task_id)
  where active = true and current_task_id is not null;

create or replace function public.fn_coerir_contexto_subtarefa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  pai public.crm_tasks%rowtype;
begin
  if tg_op = 'UPDATE' and new.parent_task_id is distinct from old.parent_task_id then
    if not (old.parent_task_id is not null and new.parent_task_id is null
      and not exists (select 1 from public.crm_tasks p
        where p.organization_id = old.organization_id and p.id = old.parent_task_id)) then
      raise exception 'parent_task_id_is_immutable' using errcode = '23514';
    end if;
  end if;
  if new.parent_task_id is null then
    if tg_op = 'UPDATE' and old.parent_task_id is null
       and exists (select 1 from public.crm_tasks f
                    where f.organization_id = new.organization_id
                      and f.parent_task_id = new.id)
       and row(new.lead_id, new.contact_id, new.demanda_id)
           is distinct from row(old.lead_id, old.contact_id, old.demanda_id) then
      null; -- o trigger AFTER propaga o novo contexto às filhas.
    end if;
    return new;
  end if;

  select * into pai
    from public.crm_tasks
   where organization_id = new.organization_id and id = new.parent_task_id;
  if not found then raise exception 'parent_task_not_in_organization' using errcode = '23503'; end if;
  if auth.uid() is not null
     and not (
       public.fn_role_at_least(pai.organization_id, 'manager')
       or public.fn_can_view_task(pai.organization_id, pai.assigned_to, pai.created_by)
       or (pai.organization_id in (select public.fn_user_org_ids())
           and public.fn_colegas_podem_mexer_na_agenda(pai.organization_id))
     ) then
    raise exception 'parent_task_not_visible' using errcode = '42501';
  end if;
  if pai.parent_task_id is not null then raise exception 'subtask_parent_must_be_root' using errcode = '23514'; end if;
  if exists (select 1 from public.crm_tasks f
              where f.organization_id = new.organization_id and f.parent_task_id = new.id) then
    raise exception 'task_with_children_cannot_become_subtask' using errcode = '23514';
  end if;

  if new.lead_id is not null and new.lead_id is distinct from pai.lead_id then
    raise exception 'subtask_lead_must_match_parent' using errcode = '23514';
  end if;
  if new.contact_id is not null and new.contact_id is distinct from pai.contact_id then
    raise exception 'subtask_contact_must_match_parent' using errcode = '23514';
  end if;
  if new.demanda_id is not null and new.demanda_id is distinct from pai.demanda_id then
    raise exception 'subtask_demanda_must_match_parent' using errcode = '23514';
  end if;
  new.lead_id := pai.lead_id;
  new.contact_id := pai.contact_id;
  new.demanda_id := pai.demanda_id;
  return new;
end;
$$;
revoke execute on function public.fn_coerir_contexto_subtarefa() from public, anon, authenticated;
grant execute on function public.fn_coerir_contexto_subtarefa() to service_role;

create or replace function public.fn_propagar_contexto_para_subtarefas()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.parent_task_id is null and
     row(new.lead_id, new.contact_id, new.demanda_id)
       is distinct from row(old.lead_id, old.contact_id, old.demanda_id) then
    update public.crm_tasks
       set lead_id = new.lead_id, contact_id = new.contact_id, demanda_id = new.demanda_id
     where organization_id = new.organization_id and parent_task_id = new.id;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_propagar_contexto_para_subtarefas() from public, anon, authenticated;
grant execute on function public.fn_propagar_contexto_para_subtarefas() to service_role;

create or replace function public.fn_validar_ponteiro_recorrencia()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  tarefa public.crm_tasks%rowtype;
begin
  if new.active and new.current_task_id is null then
    raise exception 'active_recurrence_requires_current_task' using errcode = '23514';
  end if;
  if new.active and new.mode = 'on_schedule' and new.next_run_at is null then
    raise exception 'scheduled_recurrence_requires_next_run' using errcode = '23514';
  end if;
  if new.mode = 'after_completion'
     and not (
       (new.next_run_at is null and new.next_due_at is null)
       or (new.next_run_at is not null and new.next_due_at is not null
           and new.next_due_at > new.next_run_at)
     ) then
    raise exception 'after_completion_recurrence_requires_due_pair' using errcode = '23514';
  end if;
  if new.current_task_id is not null then
    select * into tarefa from public.crm_tasks
     where organization_id = new.organization_id and id = new.current_task_id;
    if not found or tarefa.parent_task_id is not null
       or tarefa.recurrence_id is distinct from new.id
       or tarefa.recurrence_generation is distinct from new.generation then
      raise exception 'recurrence_current_task_mismatch' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.fn_validar_ponteiro_recorrencia() from public, anon, authenticated;
grant execute on function public.fn_validar_ponteiro_recorrencia() to service_role;

create or replace function public.fn_proteger_ocorrencia_corrente()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if exists (select 1 from public.crm_task_recurrences r
    where r.organization_id = old.organization_id and r.current_task_id = old.id and r.active) then
    raise exception 'active_recurrence_current_task_cannot_be_deleted' using errcode = '23514';
  end if;
  return old;
end;
$$;
revoke execute on function public.fn_proteger_ocorrencia_corrente() from public, anon, authenticated;
grant execute on function public.fn_proteger_ocorrencia_corrente() to service_role;

create or replace function public.fn_preparar_purge_tarefas_da_organizacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.crm_task_recurrences
     set active = false, current_task_id = null, next_run_at = null, next_due_at = null
   where organization_id = old.id;
  delete from public.crm_tasks where organization_id = old.id;
  delete from public.crm_task_recurrences where organization_id = old.id;
  return old;
end;
$$;
revoke execute on function public.fn_preparar_purge_tarefas_da_organizacao()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_crm_tasks_coerir_subtarefa on public.crm_tasks;
create trigger trg_crm_tasks_coerir_subtarefa
  before insert or update of parent_task_id, lead_id, contact_id, demanda_id on public.crm_tasks
  for each row execute function public.fn_coerir_contexto_subtarefa();
drop trigger if exists trg_crm_tasks_propagar_contexto on public.crm_tasks;
create trigger trg_crm_tasks_propagar_contexto
  after update of lead_id, contact_id, demanda_id on public.crm_tasks
  for each row execute function public.fn_propagar_contexto_para_subtarefas();
drop trigger if exists trg_crm_tasks_proteger_ocorrencia_corrente on public.crm_tasks;
create trigger trg_crm_tasks_proteger_ocorrencia_corrente before delete on public.crm_tasks
  for each row execute function public.fn_proteger_ocorrencia_corrente();
drop trigger if exists trg_crm_task_recurrences_validar_ponteiro on public.crm_task_recurrences;
create constraint trigger trg_crm_task_recurrences_validar_ponteiro
  after insert or update of current_task_id, generation, active, mode, next_run_at, next_due_at
  on public.crm_task_recurrences deferrable initially deferred
  for each row execute function public.fn_validar_ponteiro_recorrencia();

alter table public.crm_task_recurrences enable row level security;
drop policy if exists crm_task_recurrences_select on public.crm_task_recurrences;
create policy crm_task_recurrences_select on public.crm_task_recurrences
  for select using (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        (current_task_id is null and (
          created_by = auth.uid()
          or public.fn_role_at_least(organization_id, 'manager')
          or public.fn_colegas_podem_mexer_na_agenda(organization_id)))
        or exists (select 1 from public.crm_tasks t
          where t.organization_id = crm_task_recurrences.organization_id
            and t.id = crm_task_recurrences.current_task_id
            and (
              public.fn_role_at_least(t.organization_id, 'manager')
              or public.fn_can_view_task(t.organization_id, t.assigned_to, t.created_by)
              or public.fn_colegas_podem_mexer_na_agenda(t.organization_id)
            ))
      )
    )
  );
drop policy if exists crm_task_recurrences_write on public.crm_task_recurrences;
drop policy if exists crm_task_recurrences_insert on public.crm_task_recurrences;
create policy crm_task_recurrences_insert on public.crm_task_recurrences
  for insert with check (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and created_by = auth.uid()
      and (
        current_task_id is null
        or exists (select 1 from public.crm_tasks t
          where t.organization_id = crm_task_recurrences.organization_id
            and t.id = crm_task_recurrences.current_task_id
            and (
              public.fn_role_at_least(t.organization_id, 'manager')
              or public.fn_can_view_task(t.organization_id, t.assigned_to, t.created_by)
              or public.fn_colegas_podem_mexer_na_agenda(t.organization_id)
            ))
      ))
  );
drop policy if exists crm_task_recurrences_update on public.crm_task_recurrences;
create policy crm_task_recurrences_update on public.crm_task_recurrences
  for update using (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and (
        (current_task_id is null and (
          created_by = auth.uid()
          or public.fn_role_at_least(organization_id, 'manager')
          or public.fn_colegas_podem_mexer_na_agenda(organization_id)))
        or exists (select 1 from public.crm_tasks t
          where t.organization_id = crm_task_recurrences.organization_id
            and t.id = crm_task_recurrences.current_task_id
            and (
              public.fn_role_at_least(t.organization_id, 'manager')
              or public.fn_can_view_task(t.organization_id, t.assigned_to, t.created_by)
              or public.fn_colegas_podem_mexer_na_agenda(t.organization_id)
            ))
      ))
  ) with check (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'agent')
      and (
        (current_task_id is null and (
          created_by = auth.uid()
          or public.fn_role_at_least(organization_id, 'manager')
          or public.fn_colegas_podem_mexer_na_agenda(organization_id)))
        or exists (select 1 from public.crm_tasks t
          where t.organization_id = crm_task_recurrences.organization_id
            and t.id = crm_task_recurrences.current_task_id
            and (
              public.fn_role_at_least(t.organization_id, 'manager')
              or public.fn_can_view_task(t.organization_id, t.assigned_to, t.created_by)
              or public.fn_colegas_podem_mexer_na_agenda(t.organization_id)
            ))
      ))
  );

revoke all on table public.crm_task_recurrences from public, anon, authenticated, service_role;
grant select, insert, update on table public.crm_task_recurrences to authenticated;
grant select, insert, update on table public.crm_task_recurrences to service_role;

drop trigger if exists trg_crm_task_recurrences_updated_at on public.crm_task_recurrences;
create trigger trg_crm_task_recurrences_updated_at
  before update on public.crm_task_recurrences
  for each row execute function public.fn_set_updated_at();

drop trigger if exists trg_preparar_purge_tarefas_da_organizacao on public.organizations;
create trigger trg_preparar_purge_tarefas_da_organizacao
  before delete on public.organizations
  for each row execute function public.fn_preparar_purge_tarefas_da_organizacao();
