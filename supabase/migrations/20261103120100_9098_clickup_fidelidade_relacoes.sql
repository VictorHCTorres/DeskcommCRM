-- manifest: Preserva fidelidade operacional do ClickUp em tarefas e negócios e importa relações canônicas tenant-safe sem inferir dados ausentes.

alter table public.crm_tasks
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists start_at timestamptz,
  add column if not exists time_estimate_ms bigint,
  add column if not exists source_metadata jsonb not null default '{}'::jsonb;

alter table public.crm_tasks drop constraint if exists crm_tasks_time_estimate_nonnegative;
alter table public.crm_tasks add constraint crm_tasks_time_estimate_nonnegative
  check (time_estimate_ms is null or time_estimate_ms >= 0);
alter table public.crm_tasks drop constraint if exists crm_tasks_source_metadata_object;
alter table public.crm_tasks add constraint crm_tasks_source_metadata_object
  check (jsonb_typeof(source_metadata) = 'object');

create index if not exists crm_tasks_tags_gin_idx on public.crm_tasks using gin (tags);
create index if not exists crm_tasks_org_start_idx
  on public.crm_tasks (organization_id, start_at) where start_at is not null;

create table if not exists public.crm_clickup_relations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workspace_id text not null,
  relation_type text not null check (relation_type in ('linked','dependency')),
  source_external_id text not null,
  target_external_id text not null,
  left_lead_id uuid,
  left_task_id uuid,
  right_lead_id uuid,
  right_task_id uuid,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  source_revision text,
  created_at timestamptz not null default now(),
  constraint crm_clickup_relations_org_id_key unique (organization_id, id),
  constraint crm_clickup_relations_distinct_source check (source_external_id <> target_external_id),
  constraint crm_clickup_relations_left_exactly_one check (
    (left_lead_id is not null)::integer + (left_task_id is not null)::integer = 1
  ),
  constraint crm_clickup_relations_right_exactly_one check (
    (right_lead_id is not null)::integer + (right_task_id is not null)::integer = 1
  ),
  constraint crm_clickup_relations_linked_canonical check (
    relation_type <> 'linked' or source_external_id < target_external_id
  ),
  constraint crm_clickup_relations_left_lead_fkey foreign key (organization_id, left_lead_id)
    references public.crm_leads(organization_id, id) on delete cascade,
  constraint crm_clickup_relations_right_lead_fkey foreign key (organization_id, right_lead_id)
    references public.crm_leads(organization_id, id) on delete cascade,
  constraint crm_clickup_relations_left_task_fkey foreign key (organization_id, left_task_id)
    references public.crm_tasks(organization_id, id) on delete cascade,
  constraint crm_clickup_relations_right_task_fkey foreign key (organization_id, right_task_id)
    references public.crm_tasks(organization_id, id) on delete cascade,
  unique (organization_id, workspace_id, relation_type, source_external_id, target_external_id)
);

create index if not exists crm_clickup_relations_left_lead_idx
  on public.crm_clickup_relations (organization_id, left_lead_id) where left_lead_id is not null;
create index if not exists crm_clickup_relations_right_lead_idx
  on public.crm_clickup_relations (organization_id, right_lead_id) where right_lead_id is not null;
create index if not exists crm_clickup_relations_left_task_idx
  on public.crm_clickup_relations (organization_id, left_task_id) where left_task_id is not null;
create index if not exists crm_clickup_relations_right_task_idx
  on public.crm_clickup_relations (organization_id, right_task_id) where right_task_id is not null;

alter table public.crm_clickup_relations enable row level security;
drop policy if exists crm_clickup_relations_select on public.crm_clickup_relations;
create policy crm_clickup_relations_select on public.crm_clickup_relations for select using (
  organization_id in (select public.fn_user_org_ids()) or public.fn_is_platform_admin()
);
revoke all on public.crm_clickup_relations from public, anon, authenticated, service_role;
grant select on public.crm_clickup_relations to authenticated;
grant select, insert on public.crm_clickup_relations to service_role;

alter table public.clickup_import_items
  drop constraint if exists clickup_import_items_entity_type_check;
alter table public.clickup_import_items
  add constraint clickup_import_items_entity_type_check check (
    entity_type in (
      'workspace','space','folder','list','task','doc','doc_page','user','status','custom_field',
      'comment','attachment','task_relation'
    )
  );

create or replace function public.fn_claim_clickup_import_item_for_scope(
  p_organization_id uuid, p_run_id uuid, p_processor text,
  p_lease_seconds integer default 90
)
returns public.clickup_import_items
language plpgsql security definer set search_path = public, pg_temp as $$
declare item_row public.clickup_import_items%rowtype;
begin
  if p_processor not in ('crm', 'docs') or p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_item_processor' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.clickup_import_runs r
      join public.organizations o on o.id = r.organization_id and o.status = 'active'
     where r.organization_id = p_organization_id and r.id = p_run_id and r.status = 'running'
       and cancel_requested_at is null and lease_expires_at >= clock_timestamp()
       and (scope = p_processor or scope = 'all') and exists (
         select 1 from public.clickup_import_processor_leases pl
          where pl.run_id = r.id and pl.processor = p_processor
            and pl.lease_expires_at >= clock_timestamp()
       )
  ) then return null; end if;
  perform set_config('deskcomm.clickup_transition', 'recovery', true);
  with expired as (
    select id from public.clickup_import_items
     where organization_id = p_organization_id and run_id = p_run_id
       and status = 'processing' and claimed_until < clock_timestamp()
       and ((p_processor = 'docs' and entity_type in ('doc', 'doc_page'))
         or (p_processor = 'crm' and entity_type not in ('doc', 'doc_page')))
     order by claimed_until, id for update skip locked limit 100
  )
  update public.clickup_import_items i
     set status = case when attempts < max_attempts then 'retry_wait' else 'failed' end,
         next_attempt_at = case when attempts < max_attempts then clock_timestamp() else null end,
         claim_token = null, claimed_until = null, error_code = 'lease_expired',
         error_message = 'A tentativa expirou e poderá ser retomada.', updated_at = clock_timestamp()
   where i.id in (select id from expired);

  select * into item_row from public.clickup_import_items i
   where i.organization_id = p_organization_id and i.run_id = p_run_id and not i.execution_blocked
     and ((p_processor = 'docs' and i.entity_type in ('doc', 'doc_page'))
       or (p_processor = 'crm' and i.entity_type not in ('doc', 'doc_page')))
     and (i.status in ('ready', 'queued')
       or (i.status = 'retry_wait' and i.next_attempt_at <= clock_timestamp()))
     and (
       i.entity_type <> 'task_relation'
       or (
         (not exists (select 1 from public.clickup_import_items s
            where s.organization_id = i.organization_id and s.run_id = i.run_id
              and s.entity_type = 'task'
              and s.external_id = i.source_metadata->>'source_task_id')
          or exists (select 1 from public.clickup_import_items s
            where s.organization_id = i.organization_id and s.run_id = i.run_id
              and s.entity_type = 'task'
              and s.external_id = i.source_metadata->>'source_task_id'
              and s.status in ('succeeded','failed','skipped','cancelled','blocked')))
         and (not exists (select 1 from public.clickup_import_items t
            where t.organization_id = i.organization_id and t.run_id = i.run_id
              and t.entity_type = 'task'
              and t.external_id = i.source_metadata->>'target_task_id')
          or exists (select 1 from public.clickup_import_items t
            where t.organization_id = i.organization_id and t.run_id = i.run_id
              and t.entity_type = 'task'
              and t.external_id = i.source_metadata->>'target_task_id'
              and t.status in ('succeeded','failed','skipped','cancelled','blocked')))
       )
     )
   order by case i.entity_type
     when 'workspace' then 10 when 'space' then 20 when 'folder' then 30
     when 'list' then 40 when 'status' then 50 when 'custom_field' then 60
     when 'task' then 70 when 'task_relation' then 80
     when 'doc' then 90 when 'doc_page' then 100 else 110 end,
     case when i.entity_type = 'task' and i.parent_external_id is null then 0 else 1 end,
     i.created_at, i.id
   for update skip locked limit 1;
  if not found then return null; end if;
  perform set_config('deskcomm.clickup_transition', 'claim', true);
  update public.clickup_import_items
     set status = 'processing', attempts = attempts + 1, next_attempt_at = null,
         claim_token = gen_random_uuid(),
         claimed_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
         error_code = null, error_message = null, updated_at = clock_timestamp()
   where id = item_row.id returning * into item_row;
  return item_row;
end;
$$;

revoke execute on function public.fn_claim_clickup_import_item_for_scope(uuid,uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.fn_claim_clickup_import_item_for_scope(uuid,uuid,text,integer)
  to service_role;

comment on table public.crm_clickup_relations is
  'Vínculos create-only importados do ClickUp. Endpoints são FKs tenant-safe para negócio ou tarefa; leitura é somente da organização.';
comment on column public.crm_tasks.source_metadata is
  'Proveniência estruturada de integrações. O importador ClickUp grava em source_metadata.clickup sem inventar campos operacionais.';

-- O snapshot completo active+archived tem 5.813 objetos. O envelope continua
-- limitado a 20 MiB na rota; este teto protege quantidade sem truncar fidelidade.
create or replace function public.fn_stage_clickup_import_preview(
  p_organization_id uuid,
  p_connection_id uuid,
  p_workspace_id text,
  p_source text,
  p_scope text,
  p_manifest_version integer,
  p_snapshot_hash text,
  p_source_revision text,
  p_created_by uuid,
  p_items jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare run_id uuid := gen_random_uuid();
declare next_status text;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 10000 then
    raise exception 'invalid_clickup_preview_items' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.clickup_connections c
     where c.organization_id = p_organization_id and c.id = p_connection_id
       and c.workspace_id = p_workspace_id and c.status = 'active'
  ) then
    raise exception 'clickup_connection_not_found' using errcode = 'P0002';
  end if;
  next_status := case
    when p_scope <> 'crm' and exists (
      select 1 from jsonb_array_elements(p_items) item
       where coalesce((item->>'execution_blocked')::boolean, false)
    ) then 'blocked_missing_content'
    else 'ready'
  end;
  perform set_config('deskcomm.clickup_transition', 'stage', true);
  insert into public.clickup_import_runs
    (id, organization_id, connection_id, workspace_id, source, scope, status,
     dry_run, manifest_version, snapshot_hash, source_revision, created_by)
  values
    (run_id, p_organization_id, p_connection_id, p_workspace_id, p_source, p_scope,
     'preview', true, p_manifest_version, p_snapshot_hash, p_source_revision, p_created_by);

  insert into public.clickup_import_items
    (organization_id, run_id, workspace_id, entity_type, external_id,
     parent_external_id, source_revision, source_hash, source_metadata, source_payload,
     payload_expires_at, content_access, execution_blocked, blocked_reason, status)
  select p_organization_id, run_id, p_workspace_id, x.entity_type, x.external_id,
         x.parent_external_id, x.source_revision, x.source_hash,
         coalesce(x.source_metadata, '{}'::jsonb), x.source_payload,
         case when x.source_payload is null then null else now() + interval '30 days' end,
         x.content_access, x.execution_blocked, x.blocked_reason, x.status
    from jsonb_to_recordset(p_items) as x(
      entity_type text, external_id text, parent_external_id text, source_revision text,
      source_hash text, source_metadata jsonb, source_payload jsonb,
      content_access text, execution_blocked boolean, blocked_reason text, status text
    );
  update public.clickup_import_runs set status = next_status where id = run_id;
  return run_id;
end;
$$;

revoke execute on function public.fn_stage_clickup_import_preview(
  uuid, uuid, text, text, text, integer, text, text, uuid, jsonb
) from public, anon, authenticated;
grant execute on function public.fn_stage_clickup_import_preview(
  uuid, uuid, text, text, text, integer, text, text, uuid, jsonb
) to service_role;
