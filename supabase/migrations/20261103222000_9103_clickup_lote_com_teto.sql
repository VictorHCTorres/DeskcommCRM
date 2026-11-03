-- manifest: o banco recusa lotes grandes da prévia do ClickUp mesmo fora do cliente oficial

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
     or octet_length(p_items::text) > 262144 then
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
