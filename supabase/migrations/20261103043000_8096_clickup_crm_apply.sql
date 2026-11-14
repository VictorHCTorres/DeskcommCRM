-- manifest: Libera execução real scope-aware do envelope ClickUp e claims separados para processadores CRM/Docs, preservando CAS, leases e bloqueio de Docs sem conteúdo.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clickup-import-staging', 'clickup-import-staging', false, 20971520,
  array['application/json']::text[])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.clickup_import_items add column if not exists result_kind text;
alter table public.clickup_import_items drop constraint if exists clickup_import_items_result_kind_check;
alter table public.clickup_import_items add constraint clickup_import_items_result_kind_check
  check (result_kind is null or result_kind in ('created','updated','unchanged','skipped','conflict','validated'));
create or replace function public.fn_count_clickup_staging_warnings()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.clickup_import_runs r
     set warnings_count = r.warnings_count + warning_rows.count,
         updated_at = clock_timestamp()
    from (
      select run_id, count(*)::integer as count
        from new_clickup_items
       where source_metadata->>'attachment_status' in ('skipped_not_imported','unknown_not_exported')
       group by run_id
    ) warning_rows
   where r.id = warning_rows.run_id;
  return null;
end;
$$;
revoke execute on function public.fn_count_clickup_staging_warnings()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_count_clickup_staging_warnings on public.clickup_import_items;
create trigger trg_count_clickup_staging_warnings
after insert on public.clickup_import_items
referencing new table as new_clickup_items
for each statement execute function public.fn_count_clickup_staging_warnings();


create or replace function public.fn_execute_clickup_import_run(
  p_organization_id uuid,
  p_run_id uuid,
  p_preview_revision integer,
  p_snapshot_hash text,
  p_mapping_hash text,
  p_dry_run boolean default true
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare run_row public.clickup_import_runs%rowtype;
declare expired_docs integer;
declare execution_time timestamptz := clock_timestamp();
begin
  select * into run_row from public.clickup_import_runs
   where organization_id = p_organization_id and id = p_run_id for update;
  if not found then raise exception 'clickup_import_run_not_found' using errcode = 'P0002'; end if;
  if run_row.status <> 'ready'
     or run_row.preview_revision <> p_preview_revision
     or run_row.snapshot_hash is distinct from p_snapshot_hash
     or run_row.mapping_hash is distinct from p_mapping_hash then
    raise exception 'clickup_import_run_revision_conflict' using errcode = '40001';
  end if;
  if not p_dry_run and run_row.scope in ('crm', 'all') then
    if jsonb_typeof(run_row.mapping_config->'crm'->'lists') is distinct from 'array' then
      raise exception 'clickup_crm_mapping_required' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.clickup_import_items i
       where i.organization_id = p_organization_id and i.run_id = p_run_id
         and i.entity_type = 'list'
         and not exists (
           select 1 from jsonb_array_elements(run_row.mapping_config->'crm'->'lists') m
            where m->>'list_id' = i.external_id
              and m->>'mode' in ('crm_leads', 'crm_tasks', 'ignore')
         )
    ) then
      raise exception 'clickup_crm_list_mapping_incomplete' using errcode = 'P0001';
    end if;
  end if;
  perform set_config('deskcomm.clickup_transition', 'purge', true);
  update public.clickup_import_items
     set source_payload = null, payload_purged_at = coalesce(payload_purged_at, execution_time),
         payload_expires_at = null, status = 'blocked', execution_blocked = true,
         blocked_reason = 'clickup_doc_payload_expired', next_attempt_at = null,
         claim_token = null, claimed_until = null, updated_at = execution_time
   where organization_id = p_organization_id and run_id = p_run_id
     and entity_type in ('doc', 'doc_page')
     and status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked')
     and (source_payload is null or payload_purged_at is not null
       or payload_expires_at is null or payload_expires_at <= execution_time);
  get diagnostics expired_docs = row_count;
  if expired_docs > 0 then
    update public.clickup_import_runs
       set status = 'blocked_missing_content', error_code = 'clickup_doc_payload_expired',
           updated_at = execution_time
     where id = p_run_id returning * into run_row;
    return run_row.id;
  end if;
  perform set_config('deskcomm.clickup_transition', 'execute', true);
  update public.clickup_import_items set status = 'queued', updated_at = execution_time
   where organization_id = p_organization_id and run_id = p_run_id
     and status = 'ready' and not execution_blocked
     and (entity_type not in ('doc', 'doc_page') or (
       source_payload is not null and payload_purged_at is null
       and payload_expires_at > execution_time
     ));
  update public.clickup_import_runs
     set status = case when exists (
           select 1 from public.clickup_import_items i
            where i.organization_id = p_organization_id and i.run_id = p_run_id
              and not i.execution_blocked
         ) then 'queued' else 'completed' end,
         dry_run = p_dry_run, error_code = null,
         finished_at = case when exists (
           select 1 from public.clickup_import_items i
            where i.organization_id = p_organization_id and i.run_id = p_run_id
              and not i.execution_blocked
         ) then null else execution_time end,
         updated_at = execution_time
   where id = p_run_id returning * into run_row;
  return run_row.id;
end;
$$;

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
  select * into item_row from public.clickup_import_items
   where organization_id = p_organization_id and run_id = p_run_id and not execution_blocked
     and ((p_processor = 'docs' and entity_type in ('doc', 'doc_page'))
       or (p_processor = 'crm' and entity_type not in ('doc', 'doc_page')))
     and (status in ('ready', 'queued')
       or (status = 'retry_wait' and next_attempt_at <= clock_timestamp()))
   order by case entity_type
     when 'workspace' then 10 when 'space' then 20 when 'folder' then 30
     when 'list' then 40 when 'status' then 50 when 'custom_field' then 60
     when 'task' then 70 when 'doc' then 80 when 'doc_page' then 90 else 100 end,
     case when entity_type = 'task' and parent_external_id is null then 0 else 1 end,
     created_at, id
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

create table if not exists public.clickup_import_processor_leases (
  run_id uuid not null references public.clickup_import_runs(id) on delete cascade,
  processor text not null check (processor in ('crm', 'docs')),
  worker_id uuid not null,
  lease_token uuid not null,
  lease_expires_at timestamptz not null,
  heartbeat_at timestamptz not null,
  primary key (run_id, processor)
);
alter table public.clickup_import_processor_leases enable row level security;
revoke all on public.clickup_import_processor_leases from public, anon, authenticated, service_role;
grant select, insert, update on public.clickup_import_processor_leases to service_role;

create or replace function public.fn_claim_clickup_import_run_for_scope(
  p_worker_id uuid, p_processor text, p_lease_seconds integer default 90
)
returns public.clickup_import_runs
language plpgsql security definer set search_path = public, pg_temp as $$
declare claimed public.clickup_import_runs%rowtype;
declare processor_token uuid := gen_random_uuid();
begin
  if p_worker_id is null or p_processor not in ('crm', 'docs')
     or p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_import_processor_lease' using errcode = '22023';
  end if;
  -- `all` tem dois processadores: o lease coordena o run, enquanto os leases
  -- dos itens permitem CRM e Docs drenarem em paralelo e em várias rodadas.
  select r.* into claimed from public.clickup_import_runs r
    join public.organizations o on o.id = r.organization_id and o.status = 'active'
   where r.status = 'running' and r.cancel_requested_at is null
     and r.lease_expires_at >= clock_timestamp()
     and (r.scope = p_processor or r.scope = 'all')
     and not exists (
       select 1 from public.clickup_import_processor_leases active_lease
        where active_lease.run_id = r.id and active_lease.processor = p_processor
          and active_lease.lease_expires_at >= clock_timestamp()
          and active_lease.worker_id <> p_worker_id
     )
   order by started_at, id limit 1;
  if found then
    insert into public.clickup_import_processor_leases
      (run_id, processor, worker_id, lease_token, lease_expires_at, heartbeat_at)
    values (claimed.id, p_processor, p_worker_id, processor_token,
      clock_timestamp() + make_interval(secs => p_lease_seconds), clock_timestamp())
    on conflict (run_id, processor) do update set worker_id = excluded.worker_id,
      lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at,
      heartbeat_at = excluded.heartbeat_at
      where clickup_import_processor_leases.lease_expires_at < clock_timestamp()
         or clickup_import_processor_leases.worker_id = excluded.worker_id
    returning lease_token into processor_token;
    if not found then return null; end if;
    claimed.lease_token := processor_token;
    return claimed;
  end if;
  perform set_config('deskcomm.clickup_transition', 'recovery', true);
  with expired as (
    select id from public.clickup_import_runs
     where status = 'running' and lease_expires_at < clock_timestamp()
       and (scope = p_processor or scope = 'all')
       and not exists (select 1 from public.clickup_import_processor_leases pl
         where pl.run_id = clickup_import_runs.id and pl.lease_expires_at >= clock_timestamp())
     order by lease_expires_at, id for update skip locked limit 50
  ), recovered as (
    update public.clickup_import_runs r
       set status = case when cancel_requested_at is not null then 'cancelled'
                         when attempt >= max_attempts then 'failed' else 'queued' end,
           finished_at = case when cancel_requested_at is not null or attempt >= max_attempts
                              then clock_timestamp() else null end,
           lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null,
           error_code = case when cancel_requested_at is not null then 'cancelled'
                             when attempt >= max_attempts then 'run_attempts_exhausted'
                             else 'lease_expired' end,
           updated_at = clock_timestamp()
     where r.id in (select id from expired) returning r.id, r.status
  )
  update public.clickup_import_items i
     set status = case when r.status = 'cancelled' then 'cancelled' else 'failed' end,
         next_attempt_at = null, claim_token = null, claimed_until = null,
         error_code = case when r.status = 'failed' then 'run_attempts_exhausted' else i.error_code end,
         error_message = case when r.status = 'failed'
           then 'A importação atingiu o limite de tentativas.' else i.error_message end,
         updated_at = clock_timestamp()
    from recovered r where i.run_id = r.id
      and r.status in ('cancelled', 'failed')
      and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked');

  select r.* into claimed from public.clickup_import_runs r
    join public.organizations o on o.id = r.organization_id and o.status = 'active'
   where r.status = 'queued' and r.cancel_requested_at is null
     and r.attempt < r.max_attempts and (r.scope = p_processor or r.scope = 'all')
   order by r.created_at, r.id for update of r skip locked limit 1;
  if not found then return null; end if;
  perform set_config('deskcomm.clickup_transition', 'claim', true);
  update public.clickup_import_runs
     set status = 'running', attempt = attempt + 1, lease_owner = p_worker_id,
         lease_token = gen_random_uuid(), heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(started_at, clock_timestamp()), error_code = null,
         updated_at = clock_timestamp()
   where id = claimed.id returning * into claimed;
  insert into public.clickup_import_processor_leases
    (run_id, processor, worker_id, lease_token, lease_expires_at, heartbeat_at)
  values (claimed.id, p_processor, p_worker_id, processor_token,
    clock_timestamp() + make_interval(secs => p_lease_seconds), clock_timestamp())
  on conflict (run_id, processor) do update set worker_id = excluded.worker_id,
    lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at,
    heartbeat_at = excluded.heartbeat_at
    where clickup_import_processor_leases.lease_expires_at < clock_timestamp()
       or clickup_import_processor_leases.worker_id = excluded.worker_id
  returning lease_token into processor_token;
  if not found then return null; end if;
  claimed.lease_token := processor_token;
  return claimed;
end;
$$;

create or replace function public.fn_heartbeat_clickup_import_processor(
  p_run_id uuid, p_processor text, p_worker_id uuid, p_lease_token uuid,
  p_checkpoint jsonb default null, p_lease_seconds integer default 90
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_processor not in ('crm', 'docs') or p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_import_processor_lease' using errcode = '22023';
  end if;
  update public.clickup_import_processor_leases
     set heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds)
   where run_id = p_run_id and processor = p_processor and worker_id = p_worker_id
     and lease_token = p_lease_token and lease_expires_at >= clock_timestamp();
  if not found then return false; end if;
  update public.clickup_import_runs r set
    heartbeat_at = clock_timestamp(),
    lease_expires_at = greatest(r.lease_expires_at,
      clock_timestamp() + make_interval(secs => p_lease_seconds)),
    checkpoint = coalesce(p_checkpoint, checkpoint), updated_at = clock_timestamp()
   where r.id = p_run_id and r.status = 'running' and r.cancel_requested_at is null
     and exists (select 1 from public.organizations o
       where o.id = r.organization_id and o.status = 'active');
  return found;
end;
$$;

create or replace function public.fn_mark_clickup_import_item_result(
  p_organization_id uuid, p_item_id uuid, p_claim_token uuid, p_result_kind text
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_result_kind not in ('created','updated','unchanged','skipped','conflict','validated') then
    raise exception 'invalid_clickup_item_result_kind' using errcode = '22023';
  end if;
  update public.clickup_import_items
     set result_kind = coalesce(result_kind, p_result_kind), updated_at = clock_timestamp()
   where organization_id = p_organization_id and id = p_item_id and status = 'processing'
     and claim_token = p_claim_token and claimed_until >= clock_timestamp();
  return found;
end;
$$;

create table if not exists public.clickup_knowledge_update_receipts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null,
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  event_id uuid not null unique,
  created_at timestamptz not null default now(),
  primary key (organization_id, source_id, content_hash),
  constraint clickup_knowledge_update_source_fkey foreign key (organization_id, source_id)
    references public.ai_knowledge_sources (organization_id, id) on delete cascade
);
alter table public.clickup_knowledge_update_receipts enable row level security;
revoke all on public.clickup_knowledge_update_receipts from public, anon, authenticated, service_role;
grant select, insert on public.clickup_knowledge_update_receipts to service_role;

create or replace function public.fn_emit_clickup_knowledge_update(
  p_organization_id uuid, p_source_id uuid, p_content_hash text,
  p_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare emitted_id uuid := gen_random_uuid();
begin
  if p_content_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'invalid_clickup_knowledge_update' using errcode = '22023';
  end if;
  perform 1 from public.ai_knowledge_sources
   where organization_id = p_organization_id and id = p_source_id for update;
  if not found then raise exception 'clickup_knowledge_source_not_found' using errcode = 'P0002'; end if;
  insert into public.clickup_knowledge_update_receipts
    (organization_id, source_id, content_hash, event_id)
  values (p_organization_id, p_source_id, p_content_hash, emitted_id)
  on conflict (organization_id, source_id, content_hash) do nothing;
  if not found then
    return jsonb_build_object('emitted', false, 'replay', true);
  end if;
  update public.ai_knowledge_sources
     set status = case when active_kb_version_id is null then 'building' else status end,
         last_index_status = 'indexing_pending',
         source_metadata = source_metadata || p_metadata || jsonb_build_object(
           'clickup_content_hash', p_content_hash,
           'clickup_index_event_id', emitted_id
         ), updated_at = clock_timestamp()
   where organization_id = p_organization_id and id = p_source_id;
  insert into public.event_log
    (id, organization_id, event_type, entity_kind, entity_id, payload, metadata)
  values (
    emitted_id, p_organization_id, 'knowledge_source.updated', 'ai_knowledge_source',
    p_source_id, jsonb_build_object('knowledge_source_id', p_source_id, 'created_at', clock_timestamp()),
    jsonb_build_object('source', 'clickup_import', 'content_hash', p_content_hash)
  );
  return jsonb_build_object('emitted', true, 'replay', false, 'event_id', emitted_id);
end;
$$;

alter table public.ai_knowledge_sources
  drop constraint if exists ai_knowledge_sources_last_index_status_check;
alter table public.ai_knowledge_sources
  add constraint ai_knowledge_sources_last_index_status_check
  check (last_index_status is null or last_index_status = any (array[
    'success'::text, 'partial'::text, 'failed'::text, 'indexando'::text,
    'indexing_pending'::text, 'sem_credencial'::text
  ]));

create or replace function public.fn_activate_knowledge_version(
  p_organization_id uuid, p_source_id uuid, p_version_id uuid
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from public.ai_knowledge_sources
     where organization_id = p_organization_id and id = p_source_id
     for update
  ) then return false; end if;
  if not exists (
    select 1 from public.ai_knowledge_versions
     where organization_id = p_organization_id and knowledge_source_id = p_source_id
       and id = p_version_id and status = 'ready'
     for update
  ) then return false; end if;

  update public.ai_knowledge_versions
     set is_active = false
   where organization_id = p_organization_id and knowledge_source_id = p_source_id
     and id <> p_version_id and is_active;
  update public.ai_knowledge_versions
     set is_active = true, activated_at = clock_timestamp()
   where organization_id = p_organization_id and knowledge_source_id = p_source_id
     and id = p_version_id;
  update public.ai_knowledge_sources
     set active_kb_version_id = p_version_id, status = 'ready'
   where organization_id = p_organization_id and id = p_source_id;
  return true;
end;
$$;

revoke execute on function public.fn_execute_clickup_import_run(uuid,uuid,integer,text,text,boolean)
  from public, anon, authenticated;
revoke execute on function public.fn_claim_clickup_import_item_for_scope(uuid,uuid,text,integer)
  from public, anon, authenticated;
revoke execute on function public.fn_claim_clickup_import_run_for_scope(uuid,text,integer)
  from public, anon, authenticated;
revoke execute on function public.fn_activate_knowledge_version(uuid,uuid,uuid)
  from public, anon, authenticated;
revoke execute on function public.fn_emit_clickup_knowledge_update(uuid,uuid,text,jsonb)
  from public, anon, authenticated;
revoke execute on function public.fn_heartbeat_clickup_import_processor(uuid,text,uuid,uuid,jsonb,integer)
  from public, anon, authenticated;
revoke execute on function public.fn_mark_clickup_import_item_result(uuid,uuid,uuid,text)
  from public, anon, authenticated;
grant execute on function public.fn_execute_clickup_import_run(uuid,uuid,integer,text,text,boolean)
  to service_role;
grant execute on function public.fn_claim_clickup_import_item_for_scope(uuid,uuid,text,integer)
  to service_role;
grant execute on function public.fn_claim_clickup_import_run_for_scope(uuid,text,integer)
  to service_role;
grant execute on function public.fn_activate_knowledge_version(uuid,uuid,uuid)
  to service_role;
grant execute on function public.fn_emit_clickup_knowledge_update(uuid,uuid,text,jsonb)
  to service_role;
grant execute on function public.fn_heartbeat_clickup_import_processor(uuid,text,uuid,uuid,jsonb,integer)
  to service_role;
grant execute on function public.fn_mark_clickup_import_item_result(uuid,uuid,uuid,text)
  to service_role;

notify pgrst, 'reload schema';
