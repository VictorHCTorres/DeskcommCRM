-- manifest: Cria o envelope seguro e retomável para importar metadados do ClickUp, sem aplicar objetos no CRM nem ingerir conteúdo de Docs.

-- W1/W2 criaram tabelas graváveis depois da última varredura dinâmica do
-- baseline. Reexecutar a varredura antes das tabelas W3 mantém install e
-- upgrade com o mesmo conjunto de travas; o envelope W3, só de servidor,
-- remove explicitamente qualquer sobra dessas policies mais abaixo.
do $f$ begin perform public.fn_aplicar_travas_de_suporte(); end $f$;

-- Self-heal da W1: leitura continua aceitando platform support, mas mutações
-- exigem scope full. Mantido aqui para upgrades que já aplicaram a 8094.
drop policy if exists crm_pipeline_groups_manager_insert on public.crm_pipeline_groups;
create policy crm_pipeline_groups_manager_insert on public.crm_pipeline_groups
  for insert with check (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
  );
drop policy if exists crm_pipeline_groups_manager_update on public.crm_pipeline_groups;
create policy crm_pipeline_groups_manager_update on public.crm_pipeline_groups
  for update using (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
  ) with check (
    public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager'))
  );

create table if not exists public.clickup_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workspace_id text not null,
  workspace_name text not null,
  token_ciphertext bytea not null,
  token_iv bytea not null,
  token_tag bytea not null,
  token_last4 text not null,
  status text not null default 'active',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clickup_connections_workspace_id_check check (length(btrim(workspace_id)) between 1 and 255),
  constraint clickup_connections_workspace_name_check check (length(btrim(workspace_name)) between 1 and 255),
  constraint clickup_connections_token_shape_check check (
    octet_length(token_ciphertext) > 0 and octet_length(token_iv) = 12
    and octet_length(token_tag) = 16 and length(token_last4) between 1 and 4
  ),
  constraint clickup_connections_status_check check (status in ('active', 'revoked')),
  constraint clickup_connections_org_id_workspace_key unique (organization_id, id, workspace_id),
  constraint clickup_connections_org_workspace_key unique (organization_id, workspace_id)
);

create table if not exists public.clickup_import_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  workspace_id text not null,
  source text not null default 'api',
  scope text not null default 'crm',
  status text not null default 'preview',
  dry_run boolean not null default true,
  manifest_version integer not null default 1,
  snapshot_hash text not null,
  source_revision text,
  preview_revision integer not null default 1,
  mapping_revision integer not null default 0,
  mapping_hash text,
  mapping_config jsonb not null default '{}'::jsonb,
  attempt integer not null default 0,
  max_attempts integer not null default 5,
  lease_owner uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  heartbeat_at timestamptz,
  checkpoint jsonb not null default '{}'::jsonb,
  total_items integer not null default 0,
  applicable_items integer not null default 0,
  warnings_count integer not null default 0,
  conflicts_count integer not null default 0,
  succeeded_items integer not null default 0,
  failed_items integer not null default 0,
  skipped_items integer not null default 0,
  error_code text,
  cancel_requested_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clickup_import_runs_connection_fkey foreign key (organization_id, connection_id, workspace_id)
    references public.clickup_connections (organization_id, id, workspace_id) on delete restrict,
  constraint clickup_import_runs_status_check check (
    status in ('preview', 'blocked_missing_content', 'ready', 'queued', 'running', 'completed', 'completed_with_errors', 'failed', 'cancelled')
  ),
  constraint clickup_import_runs_source_check check (source in ('api', 'bundle')),
  constraint clickup_import_runs_scope_check check (scope in ('crm', 'docs', 'all')),
  constraint clickup_import_runs_snapshot_hash_check check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  constraint clickup_import_runs_mapping_hash_check check (
    mapping_hash is null or mapping_hash ~ '^[0-9a-f]{64}$'
  ),
  constraint clickup_import_runs_revision_check check (
    manifest_version > 0 and preview_revision > 0 and mapping_revision >= 0
    and attempt >= 0 and max_attempts between 1 and 20 and attempt <= max_attempts
  ),
  constraint clickup_import_runs_counters_check check (
    total_items >= 0 and applicable_items >= 0 and applicable_items <= total_items
    and warnings_count >= 0 and conflicts_count >= 0 and succeeded_items >= 0
    and failed_items >= 0 and skipped_items >= 0
    and succeeded_items + failed_items + skipped_items <= applicable_items
  ),
  constraint clickup_import_runs_lease_shape_check check (
    (status = 'running' and lease_owner is not null and lease_token is not null
      and lease_expires_at is not null and heartbeat_at is not null)
    or
    (status <> 'running' and lease_owner is null and lease_token is null
      and lease_expires_at is null and heartbeat_at is null)
  ),
  constraint clickup_import_runs_terminal_shape_check check (
    (status in ('completed', 'completed_with_errors', 'failed', 'cancelled') and finished_at is not null)
    or (status not in ('completed', 'completed_with_errors', 'failed', 'cancelled') and finished_at is null)
  ),
  constraint clickup_import_runs_org_id_workspace_key unique (organization_id, id, workspace_id)
);

create table if not exists public.clickup_import_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  workspace_id text not null,
  entity_type text not null,
  external_id text not null,
  parent_external_id text,
  source_revision text,
  source_hash text not null,
  source_metadata jsonb not null default '{}'::jsonb,
  source_payload jsonb,
  payload_expires_at timestamptz,
  payload_purged_at timestamptz,
  content_access text not null default 'none',
  execution_blocked boolean not null default false,
  blocked_reason text,
  status text not null default 'discovered',
  attempts integer not null default 0,
  max_attempts integer not null default 5,
  next_attempt_at timestamptz,
  claim_token uuid,
  claimed_until timestamptz,
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clickup_import_items_run_fkey foreign key (organization_id, run_id, workspace_id)
    references public.clickup_import_runs (organization_id, id, workspace_id) on delete cascade,
  constraint clickup_import_items_entity_type_check check (
    entity_type in ('workspace', 'space', 'folder', 'list', 'task', 'doc', 'doc_page', 'user', 'status', 'custom_field')
  ),
  constraint clickup_import_items_external_id_check check (length(btrim(external_id)) between 1 and 512),
  constraint clickup_import_items_source_hash_check check (source_hash ~ '^[0-9a-f]{64}$'),
  constraint clickup_import_items_content_access_check check (content_access in ('none', 'metadata_only', 'full')),
  constraint clickup_import_items_status_check check (
    status in ('discovered', 'blocked', 'ready', 'queued', 'processing', 'succeeded', 'retry_wait', 'failed', 'skipped', 'cancelled')
  ),
  constraint clickup_import_items_attempts_check check (
    attempts >= 0 and max_attempts between 1 and 20 and attempts <= max_attempts
  ),
  constraint clickup_import_items_payload_retention_check check (
    (source_payload is not null and payload_purged_at is null
      and payload_expires_at > created_at and payload_expires_at <= created_at + interval '30 days')
    or (source_payload is null and (payload_expires_at is null or payload_purged_at is not null))
  ),
  constraint clickup_import_items_claim_shape_check check (
    (status = 'processing' and claim_token is not null and claimed_until is not null)
    or (status <> 'processing' and claim_token is null and claimed_until is null)
  ),
  constraint clickup_import_items_retry_shape_check check (
    (status = 'retry_wait' and next_attempt_at is not null)
    or (status <> 'retry_wait' and next_attempt_at is null)
  ),
  constraint clickup_import_items_error_shape_check check (
    error_message is null or length(error_message) <= 500
  ),
  constraint clickup_import_items_block_shape_check check (
    (execution_blocked and blocked_reason is not null)
    or (not execution_blocked and blocked_reason is null)
  ),
  constraint clickup_import_items_docs_contract_check check (
    (entity_type not in ('doc', 'doc_page') and content_access = 'none')
    or (
      entity_type in ('doc', 'doc_page') and content_access = 'full'
      and (
        (not execution_blocked and source_payload is not null and payload_purged_at is null
          and jsonb_typeof(source_payload) = 'object'
          and coalesce(source_payload->>'format', '') in ('text', 'markdown', 'html')
          and length(btrim(coalesce(source_payload->>'content', ''))) > 0)
        or (
          source_payload is null and payload_purged_at is not null
          and (
            (status = 'blocked' and execution_blocked
              and blocked_reason = 'clickup_doc_payload_expired')
            or (status in ('succeeded', 'failed', 'skipped', 'cancelled')
              and not execution_blocked and blocked_reason is null)
          )
        )
      )
    )
    or (
      entity_type in ('doc', 'doc_page') and content_access in ('none', 'metadata_only')
      and execution_blocked and source_payload is null
    )
  ),
  constraint clickup_import_items_org_source_key unique (organization_id, run_id, entity_type, external_id)
);

create unique index if not exists crm_pipeline_groups_org_id_uidx
  on public.crm_pipeline_groups (organization_id, id);
create unique index if not exists crm_pipelines_org_id_clickup_uidx
  on public.crm_pipelines (organization_id, id);
create unique index if not exists crm_stages_org_id_clickup_uidx
  on public.crm_stages (organization_id, id);
create unique index if not exists crm_leads_org_id_clickup_uidx
  on public.crm_leads (organization_id, id);
create unique index if not exists crm_tasks_org_id_clickup_uidx
  on public.crm_tasks (organization_id, id);
create unique index if not exists ai_knowledge_sources_org_id_clickup_uidx
  on public.ai_knowledge_sources (organization_id, id);

create table if not exists public.clickup_object_mappings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  connection_id uuid not null,
  workspace_id text not null,
  entity_type text not null,
  external_id text not null,
  source_revision text,
  source_hash text not null,
  pipeline_group_id uuid,
  pipeline_id uuid,
  stage_id uuid,
  lead_id uuid,
  task_id uuid,
  knowledge_source_id uuid,
  field_key text,
  mapping_revision integer not null default 1,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clickup_object_mappings_connection_fkey foreign key (organization_id, connection_id, workspace_id)
    references public.clickup_connections (organization_id, id, workspace_id) on delete restrict,
  constraint clickup_object_mappings_pipeline_group_fkey foreign key (organization_id, pipeline_group_id)
    references public.crm_pipeline_groups (organization_id, id) on delete restrict,
  constraint clickup_object_mappings_pipeline_fkey foreign key (organization_id, pipeline_id)
    references public.crm_pipelines (organization_id, id) on delete restrict,
  constraint clickup_object_mappings_stage_fkey foreign key (organization_id, stage_id)
    references public.crm_stages (organization_id, id) on delete restrict,
  constraint clickup_object_mappings_lead_fkey foreign key (organization_id, lead_id)
    references public.crm_leads (organization_id, id) on delete restrict,
  constraint clickup_object_mappings_task_fkey foreign key (organization_id, task_id)
    references public.crm_tasks (organization_id, id) on delete restrict,
  constraint clickup_object_mappings_knowledge_source_fkey foreign key (organization_id, knowledge_source_id)
    references public.ai_knowledge_sources (organization_id, id) on delete restrict,
  constraint clickup_object_mappings_entity_type_check check (
    entity_type in ('workspace', 'space', 'folder', 'list', 'task', 'doc', 'doc_page', 'user', 'status', 'custom_field')
  ),
  constraint clickup_object_mappings_external_id_check check (length(btrim(external_id)) between 1 and 512),
  constraint clickup_object_mappings_source_hash_check check (source_hash ~ '^[0-9a-f]{64}$'),
  constraint clickup_object_mappings_revision_check check (mapping_revision > 0),
  constraint clickup_object_mappings_custom_field_shape_check check (
    (entity_type = 'custom_field' and pipeline_id is not null and field_key is not null
      and field_key ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$')
    or (entity_type <> 'custom_field' and field_key is null)
  ),
  constraint clickup_object_mappings_exactly_one_target_check check (
    num_nonnulls(pipeline_group_id, pipeline_id, stage_id, lead_id, task_id, knowledge_source_id) = 1
  ),
  constraint clickup_object_mappings_entity_target_matrix_check check (
    (entity_type in ('workspace', 'space', 'folder') and pipeline_group_id is not null)
    or (entity_type = 'list' and pipeline_id is not null and field_key is null)
    or (entity_type = 'status' and stage_id is not null)
    or (entity_type = 'task' and (lead_id is not null or task_id is not null))
    or (entity_type in ('doc', 'doc_page') and knowledge_source_id is not null)
    or (entity_type = 'custom_field' and pipeline_id is not null and field_key is not null)
  ),
  constraint clickup_object_mappings_source_key unique (organization_id, workspace_id, entity_type, external_id)
);

create index if not exists clickup_import_runs_claim_idx
  on public.clickup_import_runs (status, created_at, id)
  where status in ('queued', 'running');
create index if not exists clickup_import_runs_org_workspace_idx
  on public.clickup_import_runs (organization_id, workspace_id, created_at desc);
create index if not exists clickup_import_items_run_status_idx
  on public.clickup_import_items (organization_id, run_id, status, id);
create index if not exists clickup_import_items_claim_idx
  on public.clickup_import_items (run_id, status, next_attempt_at, created_at, id)
  where status in ('ready', 'queued', 'processing', 'retry_wait');
create index if not exists clickup_import_items_payload_expiry_idx
  on public.clickup_import_items (payload_expires_at)
  where source_payload is not null;
create index if not exists clickup_object_mappings_source_idx
  on public.clickup_object_mappings (organization_id, workspace_id, entity_type, external_id);

drop function if exists public.fn_recount_clickup_import_run(uuid);
create or replace function public.fn_apply_clickup_import_counter_delta(
  p_run_id uuid, p_total integer, p_applicable integer, p_warnings integer,
  p_conflicts integer, p_succeeded integer, p_failed integer, p_skipped integer
)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.clickup_import_runs set
    total_items = total_items + p_total,
    applicable_items = applicable_items + p_applicable,
    warnings_count = warnings_count + p_warnings,
    conflicts_count = conflicts_count + p_conflicts,
    succeeded_items = succeeded_items + p_succeeded,
    failed_items = failed_items + p_failed,
    skipped_items = skipped_items + p_skipped,
    updated_at = clock_timestamp()
   where id = p_run_id;
end;
$$;
create or replace function public.fn_refresh_clickup_import_run_counters_insert()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare delta record;
begin
  for delta in
    select run_id, count(*)::integer total,
      count(*) filter (where not execution_blocked)::integer applicable,
      count(*) filter (where execution_blocked)::integer warnings,
      count(*) filter (where error_code = 'mapping_conflict')::integer conflicts,
      count(*) filter (where status = 'succeeded')::integer succeeded,
      count(*) filter (where status = 'failed')::integer failed,
      count(*) filter (where status = 'skipped')::integer skipped
      from new_items group by run_id
  loop
    perform public.fn_apply_clickup_import_counter_delta(delta.run_id, delta.total,
      delta.applicable, delta.warnings, delta.conflicts, delta.succeeded, delta.failed, delta.skipped);
  end loop;
  return null;
end;
$$;
create or replace function public.fn_refresh_clickup_import_run_counters_update()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare delta record;
begin
  for delta in
    with n as (
      select run_id, count(*)::integer total,
        count(*) filter (where not execution_blocked)::integer applicable,
        count(*) filter (where execution_blocked)::integer warnings,
        count(*) filter (where error_code = 'mapping_conflict')::integer conflicts,
        count(*) filter (where status = 'succeeded')::integer succeeded,
        count(*) filter (where status = 'failed')::integer failed,
        count(*) filter (where status = 'skipped')::integer skipped
        from new_items group by run_id
    ), o as (
      select run_id, count(*)::integer total,
        count(*) filter (where not execution_blocked)::integer applicable,
        count(*) filter (where execution_blocked)::integer warnings,
        count(*) filter (where error_code = 'mapping_conflict')::integer conflicts,
        count(*) filter (where status = 'succeeded')::integer succeeded,
        count(*) filter (where status = 'failed')::integer failed,
        count(*) filter (where status = 'skipped')::integer skipped
        from old_items group by run_id
    )
    select coalesce(n.run_id, o.run_id) run_id,
      coalesce(n.total, 0) - coalesce(o.total, 0) total,
      coalesce(n.applicable, 0) - coalesce(o.applicable, 0) applicable,
      coalesce(n.warnings, 0) - coalesce(o.warnings, 0) warnings,
      coalesce(n.conflicts, 0) - coalesce(o.conflicts, 0) conflicts,
      coalesce(n.succeeded, 0) - coalesce(o.succeeded, 0) succeeded,
      coalesce(n.failed, 0) - coalesce(o.failed, 0) failed,
      coalesce(n.skipped, 0) - coalesce(o.skipped, 0) skipped
      from n full join o using (run_id)
  loop
    perform public.fn_apply_clickup_import_counter_delta(delta.run_id, delta.total,
      delta.applicable, delta.warnings, delta.conflicts, delta.succeeded, delta.failed, delta.skipped);
  end loop;
  return null;
end;
$$;
create or replace function public.fn_refresh_clickup_import_run_counters_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare delta record;
begin
  for delta in
    select run_id, -count(*)::integer total,
      -count(*) filter (where not execution_blocked)::integer applicable,
      -count(*) filter (where execution_blocked)::integer warnings,
      -count(*) filter (where error_code = 'mapping_conflict')::integer conflicts,
      -count(*) filter (where status = 'succeeded')::integer succeeded,
      -count(*) filter (where status = 'failed')::integer failed,
      -count(*) filter (where status = 'skipped')::integer skipped
      from old_items group by run_id
  loop
    perform public.fn_apply_clickup_import_counter_delta(delta.run_id, delta.total,
      delta.applicable, delta.warnings, delta.conflicts, delta.succeeded, delta.failed, delta.skipped);
  end loop;
  return null;
end;
$$;
revoke execute on function public.fn_apply_clickup_import_counter_delta(uuid, integer, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
revoke execute on function public.fn_refresh_clickup_import_run_counters_insert() from public, anon, authenticated;
revoke execute on function public.fn_refresh_clickup_import_run_counters_update() from public, anon, authenticated;
revoke execute on function public.fn_refresh_clickup_import_run_counters_delete() from public, anon, authenticated;
grant execute on function public.fn_apply_clickup_import_counter_delta(uuid, integer, integer, integer, integer, integer, integer, integer) to service_role;
grant execute on function public.fn_refresh_clickup_import_run_counters_insert() to service_role;
grant execute on function public.fn_refresh_clickup_import_run_counters_update() to service_role;
grant execute on function public.fn_refresh_clickup_import_run_counters_delete() to service_role;
drop trigger if exists trg_clickup_import_items_refresh_counters on public.clickup_import_items;
drop function if exists public.fn_refresh_clickup_import_run_counters();
drop trigger if exists trg_clickup_import_items_refresh_counters_insert on public.clickup_import_items;
drop trigger if exists trg_clickup_import_items_refresh_counters_update on public.clickup_import_items;
drop trigger if exists trg_clickup_import_items_refresh_counters_delete on public.clickup_import_items;
create trigger trg_clickup_import_items_refresh_counters_insert
  after insert on public.clickup_import_items referencing new table as new_items
  for each statement execute function public.fn_refresh_clickup_import_run_counters_insert();
create trigger trg_clickup_import_items_refresh_counters_update
  after update on public.clickup_import_items referencing old table as old_items new table as new_items
  for each statement execute function public.fn_refresh_clickup_import_run_counters_update();
create trigger trg_clickup_import_items_refresh_counters_delete
  after delete on public.clickup_import_items referencing old table as old_items
  for each statement execute function public.fn_refresh_clickup_import_run_counters_delete();

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
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 5000 then
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

create or replace function public.fn_claim_clickup_import_run(
  p_worker_id uuid,
  p_lease_seconds integer default 90
)
returns public.clickup_import_runs
language plpgsql security definer set search_path = public, pg_temp as $$
declare claimed public.clickup_import_runs%rowtype;
begin
  if p_worker_id is null or p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_import_lease' using errcode = '22023';
  end if;

  perform set_config('deskcomm.clickup_transition', 'recovery', true);

  update public.clickup_import_runs
     set status = 'failed', error_code = 'run_attempts_exhausted',
         finished_at = clock_timestamp(), updated_at = clock_timestamp()
   where status = 'queued' and attempt >= max_attempts;
  update public.clickup_import_items i set status = 'failed', next_attempt_at = null,
    claim_token = null, claimed_until = null, error_code = 'run_attempts_exhausted',
    error_message = 'A importação atingiu o limite de tentativas.', updated_at = clock_timestamp()
   where i.run_id in (
     select id from public.clickup_import_runs
      where status = 'failed' and error_code = 'run_attempts_exhausted'
   ) and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked');

  with expired as (
    select id from public.clickup_import_runs
     where status = 'running' and lease_expires_at < clock_timestamp()
     order by lease_expires_at, id
     for update skip locked limit 50
  ), recovered as (
    update public.clickup_import_runs r
     set status = case
           when cancel_requested_at is not null then 'cancelled'
           when attempt >= max_attempts then 'failed'
           else 'queued'
         end,
         finished_at = case
           when cancel_requested_at is not null or attempt >= max_attempts then clock_timestamp()
           else null
         end,
         lease_owner = null, lease_token = null,
         lease_expires_at = null, heartbeat_at = null,
         error_code = case
           when cancel_requested_at is not null then 'cancelled'
           when attempt >= max_attempts then 'run_attempts_exhausted'
           else 'lease_expired'
         end,
         updated_at = clock_timestamp()
     where r.id in (select id from expired)
     returning r.id, r.status
  ), cancelled_items as (
    update public.clickup_import_items i set status = 'cancelled', next_attempt_at = null,
      claim_token = null, claimed_until = null, updated_at = clock_timestamp()
     where i.run_id in (select id from recovered where status = 'cancelled')
       and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked')
     returning i.id
  )
  update public.clickup_import_items i set status = 'failed', next_attempt_at = null,
    claim_token = null, claimed_until = null, error_code = 'run_attempts_exhausted',
    error_message = 'A importação atingiu o limite de tentativas.', updated_at = clock_timestamp()
   where i.run_id in (select id from recovered where status = 'failed')
     and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked');

  select r.* into claimed from public.clickup_import_runs r
   join public.organizations o on o.id = r.organization_id and o.status = 'active'
   where r.status = 'queued' and r.cancel_requested_at is null
     and r.attempt < r.max_attempts
   order by r.created_at, r.id
   for update of r skip locked limit 1;
  if not found then return null; end if;

  perform set_config('deskcomm.clickup_transition', 'claim', true);
  update public.clickup_import_runs
     set status = 'running', attempt = attempt + 1, lease_owner = p_worker_id,
         lease_token = gen_random_uuid(), heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         started_at = coalesce(started_at, clock_timestamp()), error_code = null,
         updated_at = clock_timestamp()
   where id = claimed.id returning * into claimed;
  return claimed;
end;
$$;

create or replace function public.fn_heartbeat_clickup_import_run(
  p_run_id uuid, p_worker_id uuid, p_lease_token uuid, p_checkpoint jsonb default null,
  p_lease_seconds integer default 90
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_import_lease' using errcode = '22023';
  end if;
  update public.clickup_import_runs
     set heartbeat_at = clock_timestamp(),
         lease_expires_at = clock_timestamp() + make_interval(secs => p_lease_seconds),
         checkpoint = coalesce(p_checkpoint, checkpoint), updated_at = clock_timestamp()
   where id = p_run_id and status = 'running' and lease_owner = p_worker_id
     and lease_token = p_lease_token and lease_expires_at >= clock_timestamp()
     and cancel_requested_at is null;
  return found;
end;
$$;

create or replace function public.fn_ack_cancel_clickup_import_run(
  p_organization_id uuid, p_run_id uuid, p_worker_id uuid, p_lease_token uuid
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from public.clickup_import_runs
     where organization_id = p_organization_id and id = p_run_id and status = 'running'
       and cancel_requested_at is not null and lease_owner = p_worker_id
       and lease_token = p_lease_token and lease_expires_at >= clock_timestamp()
     for update
  ) then
    return false;
  end if;
  perform set_config('deskcomm.clickup_transition', 'cancel_ack', true);
  update public.clickup_import_items set status = 'cancelled', next_attempt_at = null,
    claim_token = null, claimed_until = null, updated_at = clock_timestamp()
   where organization_id = p_organization_id and run_id = p_run_id
     and status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked');
  update public.clickup_import_runs set status = 'cancelled', finished_at = clock_timestamp(),
    lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null,
    updated_at = clock_timestamp()
   where organization_id = p_organization_id and id = p_run_id;
  return true;
end;
$$;

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
  if not p_dry_run then
    raise exception 'clickup_domain_apply_not_available' using errcode = 'P0001';
  end if;
  select * into run_row from public.clickup_import_runs
   where organization_id = p_organization_id and id = p_run_id for update;
  if not found then raise exception 'clickup_import_run_not_found' using errcode = 'P0002'; end if;
  if run_row.status <> 'ready'
     or run_row.preview_revision <> p_preview_revision
     or run_row.snapshot_hash is distinct from p_snapshot_hash
     or run_row.mapping_hash is distinct from p_mapping_hash then
    raise exception 'clickup_import_run_revision_conflict' using errcode = '40001';
  end if;
  perform set_config('deskcomm.clickup_transition', 'purge', true);
  update public.clickup_import_items
     set source_payload = null,
         payload_purged_at = coalesce(payload_purged_at, execution_time),
         payload_expires_at = null,
         status = 'blocked', execution_blocked = true,
         blocked_reason = 'clickup_doc_payload_expired',
         next_attempt_at = null, claim_token = null, claimed_until = null,
         updated_at = execution_time
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
  update public.clickup_import_items set status = 'queued', updated_at = clock_timestamp()
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
         dry_run = true, error_code = null,
         finished_at = case when exists (
           select 1 from public.clickup_import_items i
            where i.organization_id = p_organization_id and i.run_id = p_run_id
              and not i.execution_blocked
         ) then null else clock_timestamp() end,
         updated_at = clock_timestamp()
   where id = p_run_id returning * into run_row;
  return run_row.id;
end;
$$;

create or replace function public.fn_update_clickup_import_mapping(
  p_organization_id uuid,
  p_run_id uuid,
  p_expected_mapping_revision integer,
  p_mapping jsonb,
  p_mapping_hash text
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare run_row public.clickup_import_runs%rowtype;
begin
  if p_mapping_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_clickup_mapping_hash' using errcode = '22023';
  end if;
  update public.clickup_import_runs
     set mapping_config = p_mapping, mapping_hash = p_mapping_hash,
         mapping_revision = mapping_revision + 1,
         preview_revision = preview_revision + 1,
         updated_at = clock_timestamp()
   where organization_id = p_organization_id and id = p_run_id
     and status in ('ready', 'blocked_missing_content')
     and mapping_revision = p_expected_mapping_revision
   returning * into run_row;
  if not found then
    raise exception 'clickup_import_mapping_revision_conflict' using errcode = '40001';
  end if;
  return run_row.id;
end;
$$;

create or replace function public.fn_retry_clickup_import_run(
  p_organization_id uuid, p_run_id uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare run_row public.clickup_import_runs%rowtype;
begin
  select * into run_row from public.clickup_import_runs
   where organization_id = p_organization_id and id = p_run_id
     and status in ('failed', 'completed_with_errors') for update;
  if not found then raise exception 'clickup_import_run_not_retryable' using errcode = 'P0001'; end if;
  if not exists (
    select 1 from public.clickup_import_items
     where organization_id = p_organization_id and run_id = p_run_id
       and status in ('failed', 'retry_wait', 'processing') and attempts < max_attempts
  ) then
    raise exception 'clickup_import_run_has_no_retryable_items' using errcode = 'P0001';
  end if;
  perform set_config('deskcomm.clickup_transition', 'retry', true);
  update public.clickup_import_items
     set status = 'queued',
         next_attempt_at = null, claim_token = null, claimed_until = null,
         error_code = null, error_message = null, updated_at = clock_timestamp()
   where organization_id = p_organization_id and run_id = p_run_id
     and status in ('failed', 'retry_wait', 'processing') and attempts < max_attempts;
  update public.clickup_import_runs
     set status = 'queued', attempt = 0, error_code = null, finished_at = null,
         cancel_requested_at = null, lease_owner = null, lease_token = null,
         lease_expires_at = null, heartbeat_at = null, updated_at = clock_timestamp()
   where id = p_run_id returning * into run_row;
  return run_row.id;
end;
$$;

create or replace function public.fn_cancel_clickup_import_run(
  p_organization_id uuid, p_run_id uuid
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare run_row public.clickup_import_runs%rowtype;
begin
  select * into run_row from public.clickup_import_runs
   where organization_id = p_organization_id and id = p_run_id for update;
  if not found then raise exception 'clickup_import_run_not_found' using errcode = 'P0002'; end if;
  if run_row.status in ('completed', 'completed_with_errors', 'failed', 'cancelled') then
    raise exception 'clickup_import_run_not_cancellable' using errcode = 'P0001';
  end if;
  perform set_config('deskcomm.clickup_transition', 'cancel', true);
  if run_row.status = 'running' then
    update public.clickup_import_runs set cancel_requested_at = clock_timestamp(),
      updated_at = clock_timestamp() where id = p_run_id returning * into run_row;
  else
    update public.clickup_import_items set status = 'cancelled', next_attempt_at = null,
      claim_token = null, claimed_until = null, updated_at = clock_timestamp()
     where organization_id = p_organization_id and run_id = p_run_id
       and status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked');
    update public.clickup_import_runs set status = 'cancelled',
      cancel_requested_at = clock_timestamp(), finished_at = clock_timestamp(),
      lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null,
      updated_at = clock_timestamp() where id = p_run_id returning * into run_row;
  end if;
  return run_row.id;
end;
$$;

create or replace function public.fn_claim_clickup_import_item(
  p_organization_id uuid, p_run_id uuid, p_lease_seconds integer default 90
)
returns public.clickup_import_items
language plpgsql security definer set search_path = public, pg_temp as $$
declare item_row public.clickup_import_items%rowtype;
begin
  if p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_item_lease' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.clickup_import_runs
     where organization_id = p_organization_id and id = p_run_id
       and status = 'running' and cancel_requested_at is null
       and lease_expires_at >= clock_timestamp()
  ) then
    return null;
  end if;
  perform set_config('deskcomm.clickup_transition', 'recovery', true);
  with expired as (
    select id from public.clickup_import_items
     where organization_id = p_organization_id and run_id = p_run_id
       and status = 'processing' and claimed_until < clock_timestamp()
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
     and (status in ('ready', 'queued')
       or (status = 'retry_wait' and next_attempt_at <= clock_timestamp()))
   order by created_at, id for update skip locked limit 1;
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

create or replace function public.fn_finish_clickup_import_item(
  p_organization_id uuid,
  p_item_id uuid,
  p_claim_token uuid,
  p_outcome text,
  p_retry_at timestamptz default null,
  p_error_code text default null,
  p_error_message text default null
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare item_row public.clickup_import_items%rowtype;
declare terminal_status text;
begin
  if p_outcome not in ('succeeded', 'skipped', 'failed', 'retry_wait') then
    raise exception 'invalid_clickup_item_outcome' using errcode = '22023';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,80}$' then
    raise exception 'invalid_clickup_error_code' using errcode = '22023';
  end if;
  if p_error_message is not null
     and (length(p_error_message) > 500 or p_error_message ~ '[[:cntrl:]]') then
    raise exception 'invalid_clickup_error_message' using errcode = '22023';
  end if;
  if p_outcome in ('succeeded', 'skipped')
     and (p_error_code is not null or p_error_message is not null or p_retry_at is not null) then
    raise exception 'clickup_success_cannot_have_error' using errcode = '22023';
  end if;
  if p_outcome = 'retry_wait'
     and (p_retry_at is null or p_retry_at <= clock_timestamp()) then
    raise exception 'clickup_retry_requires_future_time' using errcode = '22023';
  end if;

  perform set_config('deskcomm.clickup_transition', 'finish', true);

  update public.clickup_import_items i
     set status = p_outcome,
         next_attempt_at = case when p_outcome = 'retry_wait' then p_retry_at else null end,
         claim_token = null, claimed_until = null,
         error_code = p_error_code, error_message = p_error_message,
         updated_at = clock_timestamp()
   where i.organization_id = p_organization_id and i.id = p_item_id
     and i.status = 'processing' and i.claim_token = p_claim_token
     and i.claimed_until >= clock_timestamp()
     and (p_outcome <> 'retry_wait' or i.attempts < i.max_attempts)
   returning i.* into item_row;
  if not found then return false; end if;

  if p_outcome <> 'retry_wait'
     and not exists (
       select 1 from public.clickup_import_items pending
        where pending.organization_id = p_organization_id and pending.run_id = item_row.run_id
          and not pending.execution_blocked
          and pending.status not in ('succeeded', 'failed', 'skipped', 'cancelled')
     ) then
    select case when exists (
      select 1 from public.clickup_import_items failed
       where failed.organization_id = p_organization_id and failed.run_id = item_row.run_id
         and failed.status = 'failed'
    ) then 'completed_with_errors' else 'completed' end into terminal_status;
    update public.clickup_import_runs set status = terminal_status,
      finished_at = clock_timestamp(), lease_owner = null, lease_token = null,
      lease_expires_at = null, heartbeat_at = null, updated_at = clock_timestamp()
     where organization_id = p_organization_id and id = item_row.run_id
       and status = 'running' and cancel_requested_at is null;
  end if;
  return true;
end;
$$;

create or replace function public.fn_heartbeat_clickup_import_item(
  p_item_id uuid, p_claim_token uuid, p_lease_seconds integer default 90
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_item_lease' using errcode = '22023';
  end if;
  update public.clickup_import_items
     set claimed_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   where id = p_item_id and status = 'processing' and claim_token = p_claim_token
     and claimed_until >= clock_timestamp();
  return found;
end;
$$;

create or replace function public.fn_purge_expired_clickup_payloads(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare affected integer;
declare expired_ids uuid[];
declare affected_runs uuid[];
begin
  select array_agg(x.id), array_agg(distinct x.run_id)
    into expired_ids, affected_runs
    from (
      select i.id, i.run_id
        from public.clickup_import_items i
        join public.clickup_import_runs r on r.id = i.run_id
       where i.source_payload is not null and i.payload_expires_at <= clock_timestamp()
       order by r.id, i.payload_expires_at, i.id
       for update of r, i skip locked
       limit greatest(1, least(p_limit, 5000))
    ) x;
  affected := coalesce(cardinality(expired_ids), 0);
  if affected = 0 then return 0; end if;
  perform set_config('deskcomm.clickup_transition', 'purge', true);
  update public.clickup_import_items i
     set source_payload = null, payload_purged_at = clock_timestamp(), payload_expires_at = null,
         status = case when i.entity_type in ('doc', 'doc_page')
           and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked')
           then 'blocked' else i.status end,
         execution_blocked = case when i.entity_type in ('doc', 'doc_page')
           and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked')
           then true else i.execution_blocked end,
         blocked_reason = case when i.entity_type in ('doc', 'doc_page')
           and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked')
           then 'clickup_doc_payload_expired' else i.blocked_reason end,
         next_attempt_at = case when i.entity_type in ('doc', 'doc_page')
           and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked')
           then null else i.next_attempt_at end,
         claim_token = case when i.entity_type in ('doc', 'doc_page')
           and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked')
           then null else i.claim_token end,
         claimed_until = case when i.entity_type in ('doc', 'doc_page')
           and i.status not in ('succeeded', 'failed', 'skipped', 'cancelled', 'blocked')
           then null else i.claimed_until end,
         updated_at = clock_timestamp()
   where i.id = any(expired_ids);
  update public.clickup_import_runs r
     set status = 'blocked_missing_content', error_code = 'clickup_doc_payload_expired',
         lease_owner = null, lease_token = null, lease_expires_at = null, heartbeat_at = null,
         updated_at = clock_timestamp()
   where r.id = any(affected_runs)
     and r.status in ('preview', 'ready', 'queued', 'running', 'blocked_missing_content')
     and exists (select 1 from public.clickup_import_items i
       where i.run_id = r.id and i.status = 'blocked'
         and i.blocked_reason = 'clickup_doc_payload_expired');
  return affected;
end;
$$;

revoke execute on function public.fn_claim_clickup_import_run(uuid, integer) from public, anon, authenticated;
revoke execute on function public.fn_stage_clickup_import_preview(uuid, uuid, text, text, text, integer, text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.fn_heartbeat_clickup_import_run(uuid, uuid, uuid, jsonb, integer) from public, anon, authenticated;
revoke execute on function public.fn_ack_cancel_clickup_import_run(uuid, uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fn_execute_clickup_import_run(uuid, uuid, integer, text, text, boolean) from public, anon, authenticated;
revoke execute on function public.fn_update_clickup_import_mapping(uuid, uuid, integer, jsonb, text) from public, anon, authenticated;
revoke execute on function public.fn_retry_clickup_import_run(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fn_cancel_clickup_import_run(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.fn_claim_clickup_import_item(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.fn_finish_clickup_import_item(uuid, uuid, uuid, text, timestamptz, text, text) from public, anon, authenticated;
revoke execute on function public.fn_heartbeat_clickup_import_item(uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function public.fn_purge_expired_clickup_payloads(integer) from public, anon, authenticated;
grant execute on function public.fn_claim_clickup_import_run(uuid, integer) to service_role;
grant execute on function public.fn_stage_clickup_import_preview(uuid, uuid, text, text, text, integer, text, text, uuid, jsonb) to service_role;
grant execute on function public.fn_heartbeat_clickup_import_run(uuid, uuid, uuid, jsonb, integer) to service_role;
grant execute on function public.fn_ack_cancel_clickup_import_run(uuid, uuid, uuid, uuid) to service_role;
grant execute on function public.fn_execute_clickup_import_run(uuid, uuid, integer, text, text, boolean) to service_role;
grant execute on function public.fn_update_clickup_import_mapping(uuid, uuid, integer, jsonb, text) to service_role;
grant execute on function public.fn_retry_clickup_import_run(uuid, uuid) to service_role;
grant execute on function public.fn_cancel_clickup_import_run(uuid, uuid) to service_role;
grant execute on function public.fn_claim_clickup_import_item(uuid, uuid, integer) to service_role;
grant execute on function public.fn_finish_clickup_import_item(uuid, uuid, uuid, text, timestamptz, text, text) to service_role;
grant execute on function public.fn_heartbeat_clickup_import_item(uuid, uuid, integer) to service_role;
grant execute on function public.fn_purge_expired_clickup_payloads(integer) to service_role;

alter table public.clickup_connections enable row level security;
alter table public.clickup_import_runs enable row level security;
alter table public.clickup_import_items enable row level security;
alter table public.clickup_object_mappings enable row level security;

-- `fn_aplicar_travas_de_suporte()` é executada antes deste apêndice no
-- baseline. Numa reaplicação ela encontra estas tabelas já existentes e cria
-- as policies restritivas dinamicamente. O envelope é exclusivamente escrito
-- pela service role, portanto removemos essas sobras tanto no install quanto
-- no reapply para manter o catálogo convergente.
drop policy if exists support_write_insert on public.clickup_connections;
drop policy if exists support_write_update on public.clickup_connections;
drop policy if exists support_write_delete on public.clickup_connections;
drop policy if exists support_write_insert on public.clickup_import_runs;
drop policy if exists support_write_update on public.clickup_import_runs;
drop policy if exists support_write_delete on public.clickup_import_runs;
drop policy if exists support_write_insert on public.clickup_import_items;
drop policy if exists support_write_update on public.clickup_import_items;
drop policy if exists support_write_delete on public.clickup_import_items;
drop policy if exists support_write_insert on public.clickup_object_mappings;
drop policy if exists support_write_update on public.clickup_object_mappings;
drop policy if exists support_write_delete on public.clickup_object_mappings;

drop policy if exists clickup_connections_admin_select on public.clickup_connections;
drop policy if exists clickup_connections_admin_insert on public.clickup_connections;
drop policy if exists clickup_connections_admin_update on public.clickup_connections;

drop view if exists public.clickup_connections_safe;
create view public.clickup_connections_safe with (security_barrier = true) as
select id, organization_id, workspace_id, workspace_name, token_last4, status,
       created_by, created_at, updated_at
  from public.clickup_connections
 where public.fn_is_platform_admin_full()
    or (organization_id in (select public.fn_user_org_ids())
        and public.fn_role_at_least(organization_id, 'admin'));

drop policy if exists clickup_import_runs_manager_select on public.clickup_import_runs;
create policy clickup_import_runs_manager_select on public.clickup_import_runs for select using (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);
drop policy if exists clickup_import_runs_manager_insert on public.clickup_import_runs;
create policy clickup_import_runs_manager_insert on public.clickup_import_runs for insert with check (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);
drop policy if exists clickup_import_runs_manager_update on public.clickup_import_runs;
create policy clickup_import_runs_manager_update on public.clickup_import_runs for update using (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
) with check (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);

drop policy if exists clickup_import_items_manager_select on public.clickup_import_items;
create policy clickup_import_items_manager_select on public.clickup_import_items for select using (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);
drop policy if exists clickup_import_items_manager_insert on public.clickup_import_items;
create policy clickup_import_items_manager_insert on public.clickup_import_items for insert with check (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);
drop policy if exists clickup_import_items_manager_update on public.clickup_import_items;
create policy clickup_import_items_manager_update on public.clickup_import_items for update using (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
) with check (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);

drop policy if exists clickup_object_mappings_manager_select on public.clickup_object_mappings;
create policy clickup_object_mappings_manager_select on public.clickup_object_mappings for select using (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);
drop policy if exists clickup_object_mappings_manager_insert on public.clickup_object_mappings;
create policy clickup_object_mappings_manager_insert on public.clickup_object_mappings for insert with check (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);
drop policy if exists clickup_object_mappings_manager_update on public.clickup_object_mappings;
create policy clickup_object_mappings_manager_update on public.clickup_object_mappings for update using (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
) with check (
  public.fn_is_platform_admin_full() or (
    organization_id in (select public.fn_user_org_ids())
    and public.fn_role_at_least(organization_id, 'manager')
  )
);

revoke all on table public.clickup_connections from public, anon, authenticated, service_role;
revoke all on table public.clickup_import_runs from public, anon, authenticated, service_role;
revoke all on table public.clickup_import_items from public, anon, authenticated, service_role;
revoke all on table public.clickup_object_mappings from public, anon, authenticated, service_role;

grant select, insert, update on table public.clickup_connections to service_role;
grant select, insert, update on table public.clickup_import_runs to service_role;
grant select, insert, update on table public.clickup_import_items to service_role;
grant select, insert, update on table public.clickup_object_mappings to service_role;

revoke all on table public.clickup_connections_safe from public, anon, authenticated, service_role;
grant select on table public.clickup_connections_safe to authenticated, service_role;

grant select (
  id, organization_id, connection_id, workspace_id, source, scope, status, dry_run,
  manifest_version, snapshot_hash, source_revision, preview_revision,
  mapping_revision, mapping_hash, attempt, max_attempts, checkpoint, error_code,
  total_items, applicable_items, warnings_count, conflicts_count,
  succeeded_items, failed_items, skipped_items,
  cancel_requested_at, started_at, finished_at, created_by, created_at, updated_at
) on table public.clickup_import_runs to authenticated;
grant select (
  id, organization_id, run_id, workspace_id, entity_type, external_id, parent_external_id,
  source_revision, source_hash, source_metadata, content_access, execution_blocked,
  blocked_reason, status, attempts, max_attempts, next_attempt_at, error_code,
  error_message, payload_purged_at,
  created_at, updated_at
) on table public.clickup_import_items to authenticated;
grant select on table public.clickup_object_mappings to authenticated;

create or replace function public.fn_guard_clickup_run_transition()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare transition text := coalesce(current_setting('deskcomm.clickup_transition', true), '');
begin
  if new.status = old.status then return new; end if;
  if old.status in ('completed', 'cancelled') then
    raise exception 'clickup_terminal_run_is_immutable' using errcode = '23514';
  end if;
  if old.status in ('failed', 'completed_with_errors')
     and not (new.status = 'queued' and transition = 'retry') then
    raise exception 'clickup_terminal_run_requires_retry' using errcode = '23514';
  end if;
  if not (
    (old.status = 'preview' and new.status in ('ready', 'blocked_missing_content')
      and transition in ('stage', 'purge'))
    or (old.status in ('ready', 'queued', 'running') and new.status = 'blocked_missing_content'
      and transition = 'purge')
    or (old.status = 'ready' and new.status in ('queued', 'completed') and transition = 'execute')
    or (old.status in ('preview', 'blocked_missing_content', 'ready', 'queued')
        and new.status = 'cancelled' and transition = 'cancel')
    or (old.status = 'queued' and new.status = 'running' and transition = 'claim')
    or (old.status = 'queued' and new.status = 'failed' and transition = 'recovery')
    or (old.status = 'running' and new.status in ('queued', 'failed', 'cancelled')
        and transition in ('recovery', 'cancel_ack'))
    or (old.status = 'running' and new.status in ('completed', 'completed_with_errors')
        and transition = 'finish')
    or (old.status in ('failed', 'completed_with_errors') and new.status = 'queued'
        and transition = 'retry')
  ) then
    raise exception 'invalid_clickup_run_transition:%->%', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.fn_guard_clickup_item_transition()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare transition text := coalesce(current_setting('deskcomm.clickup_transition', true), '');
begin
  if new.status = old.status then return new; end if;
  if old.status in ('succeeded', 'skipped', 'cancelled', 'blocked') then
    raise exception 'clickup_terminal_item_is_immutable' using errcode = '23514';
  end if;
  if old.status = 'failed' and not (new.status = 'queued' and transition = 'retry') then
    raise exception 'clickup_failed_item_requires_retry' using errcode = '23514';
  end if;
  if not (
    (old.status = 'ready' and new.status = 'queued' and transition = 'execute')
    or (old.status in ('ready', 'queued', 'retry_wait') and new.status = 'processing'
        and transition = 'claim')
    or (old.status = 'processing' and new.status in ('retry_wait', 'failed')
        and transition in ('finish', 'recovery'))
    or (old.status in ('ready', 'queued', 'retry_wait') and new.status = 'failed'
        and transition = 'recovery')
    or (old.status = 'processing' and new.status in ('succeeded', 'skipped')
        and transition = 'finish')
    or (old.status = 'failed' and new.status = 'queued' and transition = 'retry')
    or (old.status in ('retry_wait', 'processing') and new.status = 'queued'
        and transition = 'retry')
    or (old.status in ('discovered', 'ready', 'queued', 'processing', 'retry_wait')
        and new.status = 'cancelled' and transition in ('cancel', 'cancel_ack', 'recovery'))
    or (old.status in ('discovered', 'ready', 'queued', 'processing', 'retry_wait')
        and new.status = 'blocked' and transition = 'purge')
  ) then
    raise exception 'invalid_clickup_item_transition:%->%', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.fn_guard_clickup_run_transition() from public, anon, authenticated;
revoke execute on function public.fn_guard_clickup_item_transition() from public, anon, authenticated;
grant execute on function public.fn_guard_clickup_run_transition() to service_role;
grant execute on function public.fn_guard_clickup_item_transition() to service_role;

drop trigger if exists trg_clickup_import_runs_guard_transition on public.clickup_import_runs;
create trigger trg_clickup_import_runs_guard_transition before update of status
  on public.clickup_import_runs for each row execute function public.fn_guard_clickup_run_transition();
drop trigger if exists trg_clickup_import_items_guard_transition on public.clickup_import_items;
create trigger trg_clickup_import_items_guard_transition before update of status
  on public.clickup_import_items for each row execute function public.fn_guard_clickup_item_transition();

drop trigger if exists trg_clickup_connections_updated_at on public.clickup_connections;
create trigger trg_clickup_connections_updated_at before update on public.clickup_connections
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_clickup_import_runs_updated_at on public.clickup_import_runs;
create trigger trg_clickup_import_runs_updated_at before update on public.clickup_import_runs
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_clickup_import_items_updated_at on public.clickup_import_items;
create trigger trg_clickup_import_items_updated_at before update on public.clickup_import_items
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_clickup_object_mappings_updated_at on public.clickup_object_mappings;
create trigger trg_clickup_object_mappings_updated_at before update on public.clickup_object_mappings
  for each row execute function public.fn_set_updated_at();

comment on table public.clickup_connections is
  'Credenciais ClickUp cifradas com AES-256-GCM. Nunca selecionar por client authenticated.';
comment on column public.clickup_import_items.source_payload is
  'Staging bruto temporário, inacessível a authenticated e expurgável em no máximo 30 dias.';
comment on table public.clickup_object_mappings is
  'Identidade durável ClickUp→Deskcomm, separada do payload temporário de staging.';
