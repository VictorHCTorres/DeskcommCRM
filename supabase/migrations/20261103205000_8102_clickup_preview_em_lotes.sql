-- manifest: Grava, sela e expurga com segurança prévias ClickUp em lotes, evitando timeout, corrida e rascunho órfão.

create or replace function public.fn_expurgar_clickup_preview_staging(p_limite integer default 25)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare removed_count integer;
begin
  if p_limite not between 1 and 100 then
    raise exception 'invalid_clickup_preview_cleanup_limit' using errcode = '22023';
  end if;
  with removed as (
    delete from public.clickup_import_runs
     where id in (
       select id from public.clickup_import_runs
        where status in ('preview', 'cancelled')
          and checkpoint->>'staging' = 'true'
          and updated_at < clock_timestamp() - interval '1 hour'
        order by updated_at
        limit p_limite
        for update skip locked
     )
    returning 1
  )
  select count(*)::integer into removed_count from removed;
  return removed_count;
end;
$$;

create or replace function public.fn_begin_clickup_import_preview(
  p_organization_id uuid, p_run_id uuid, p_connection_id uuid, p_workspace_id text,
  p_source text, p_scope text, p_manifest_version integer, p_snapshot_hash text,
  p_source_revision text, p_created_by uuid
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.fn_expurgar_clickup_preview_staging(25);

  perform 1 from public.clickup_connections
   where organization_id = p_organization_id and id = p_connection_id
     and workspace_id = p_workspace_id and status = 'active' for update;
  if not found then
    raise exception 'clickup_connection_not_found' using errcode = 'P0002';
  end if;

  insert into public.clickup_import_runs
    (id, organization_id, connection_id, workspace_id, source, scope, status,
     dry_run, manifest_version, snapshot_hash, source_revision, checkpoint, created_by)
  values
    (p_run_id, p_organization_id, p_connection_id, p_workspace_id, p_source, p_scope,
     'preview', true, p_manifest_version, p_snapshot_hash, p_source_revision,
     '{"staging":true}'::jsonb, p_created_by);
  return p_run_id;
end;
$$;

create or replace function public.fn_append_clickup_import_preview_items(
  p_organization_id uuid, p_run_id uuid, p_items jsonb
)
returns integer language plpgsql security definer set search_path = public, pg_temp as $$
declare
  run_row public.clickup_import_runs%rowtype;
  inserted_count integer;
begin
  if jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) not between 1 and 100
     or pg_column_size(p_items) > 3145728 then
    raise exception 'invalid_clickup_preview_batch' using errcode = '22023';
  end if;

  select * into run_row from public.clickup_import_runs
   where organization_id = p_organization_id and id = p_run_id for update;
  if not found or run_row.status <> 'preview' or run_row.checkpoint->>'staging' <> 'true' then
    raise exception 'clickup_preview_not_appendable' using errcode = 'P0002';
  end if;
  if run_row.total_items + jsonb_array_length(p_items) > 10000 then
    raise exception 'clickup_manifest_limit_exceeded' using errcode = '22023';
  end if;

  with inserted as (
    insert into public.clickup_import_items
      (organization_id, run_id, workspace_id, entity_type, external_id,
       parent_external_id, source_revision, source_hash, source_metadata, source_payload,
       payload_expires_at, content_access, execution_blocked, blocked_reason, status)
    select p_organization_id, p_run_id, run_row.workspace_id, x.entity_type, x.external_id,
           x.parent_external_id, x.source_revision, x.source_hash,
           coalesce(x.source_metadata, '{}'::jsonb), x.source_payload,
           case when x.source_payload is null then null else now() + interval '30 days' end,
           x.content_access, x.execution_blocked, x.blocked_reason, x.status
      from jsonb_to_recordset(p_items) as x(
        entity_type text, external_id text, parent_external_id text, source_revision text,
        source_hash text, source_metadata jsonb, source_payload jsonb,
        content_access text, execution_blocked boolean, blocked_reason text, status text
      )
    returning 1
  )
  select count(*)::integer into inserted_count from inserted;
  return inserted_count;
end;
$$;

create or replace function public.fn_finalize_clickup_import_preview(
  p_organization_id uuid, p_run_id uuid, p_expected_items integer
)
returns uuid language plpgsql security definer set search_path = public, pg_temp as $$
declare
  run_row public.clickup_import_runs%rowtype;
  actual_items integer;
  blocked_items integer;
  next_status text;
begin
  if p_expected_items not between 0 and 10000 then
    raise exception 'invalid_clickup_preview_finalization' using errcode = '22023';
  end if;

  select * into run_row from public.clickup_import_runs
   where organization_id = p_organization_id and id = p_run_id for update;
  if not found then
    raise exception 'clickup_preview_not_found' using errcode = 'P0002';
  end if;

  select count(*)::integer, count(*) filter (where execution_blocked)::integer
    into actual_items, blocked_items from public.clickup_import_items
   where organization_id = p_organization_id and run_id = p_run_id;
  next_status := case
    when run_row.scope <> 'crm' and blocked_items > 0 then 'blocked_missing_content'
    else 'ready'
  end;

  if actual_items <> p_expected_items or run_row.total_items <> p_expected_items then
    raise exception 'incomplete_clickup_preview:%/%', actual_items, p_expected_items
      using errcode = '23514';
  end if;
  if run_row.status = next_status and run_row.checkpoint->>'staging' is null then
    return p_run_id;
  end if;
  if run_row.status <> 'preview' or run_row.checkpoint->>'staging' <> 'true' then
    raise exception 'clickup_preview_not_finalizable' using errcode = 'P0002';
  end if;

  perform set_config('deskcomm.clickup_transition', 'stage', true);
  update public.clickup_import_runs
     set status = next_status, checkpoint = checkpoint - 'staging',
         updated_at = clock_timestamp()
   where organization_id = p_organization_id and id = p_run_id;
  return p_run_id;
end;
$$;

create or replace function public.fn_abort_clickup_import_preview(
  p_organization_id uuid, p_run_id uuid
)
returns boolean language plpgsql security definer set search_path = public, pg_temp as $$
declare removed_id uuid;
begin
  delete from public.clickup_import_runs
   where organization_id = p_organization_id and id = p_run_id
     and status in ('preview', 'cancelled') and checkpoint->>'staging' = 'true'
  returning id into removed_id;
  return removed_id is not null;
end;
$$;

create or replace function public.fn_guard_clickup_staging_aux_write()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (
    select 1 from public.clickup_import_runs
     where organization_id = new.organization_id and id = new.run_id
       and checkpoint->>'staging' = 'true'
  ) then
    raise exception 'clickup_preview_still_staging' using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clickup_asset_sidecar_no_staging on public.clickup_asset_sidecars;
create trigger trg_clickup_asset_sidecar_no_staging
  before insert or update on public.clickup_asset_sidecars
  for each row execute function public.fn_guard_clickup_staging_aux_write();
drop trigger if exists trg_clickup_asset_upload_no_staging on public.clickup_asset_uploads;
create trigger trg_clickup_asset_upload_no_staging
  before insert or update on public.clickup_asset_uploads
  for each row execute function public.fn_guard_clickup_staging_aux_write();

revoke execute on function public.fn_expurgar_clickup_preview_staging(integer) from public, anon, authenticated;
revoke execute on function public.fn_begin_clickup_import_preview(uuid,uuid,uuid,text,text,text,integer,text,text,uuid) from public, anon, authenticated;
revoke execute on function public.fn_append_clickup_import_preview_items(uuid,uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.fn_finalize_clickup_import_preview(uuid,uuid,integer) from public, anon, authenticated;
revoke execute on function public.fn_abort_clickup_import_preview(uuid,uuid) from public, anon, authenticated;
revoke execute on function public.fn_guard_clickup_staging_aux_write() from public, anon, authenticated;
grant execute on function public.fn_expurgar_clickup_preview_staging(integer) to service_role;
grant execute on function public.fn_begin_clickup_import_preview(uuid,uuid,uuid,text,text,text,integer,text,text,uuid) to service_role;
grant execute on function public.fn_append_clickup_import_preview_items(uuid,uuid,jsonb) to service_role;
grant execute on function public.fn_finalize_clickup_import_preview(uuid,uuid,integer) to service_role;
grant execute on function public.fn_abort_clickup_import_preview(uuid,uuid) to service_role;
grant execute on function public.fn_guard_clickup_staging_aux_write() to service_role;
