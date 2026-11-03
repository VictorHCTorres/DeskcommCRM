-- manifest: Converte recusas permanentes do importador ClickUp de serialization_failure para PT409, impedindo retries automáticos infinitos do PostgREST.

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
    raise exception 'clickup_import_run_revision_conflict' using errcode = 'PT409';
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
    raise exception 'clickup_import_mapping_revision_conflict' using errcode = 'PT409';
  end if;
  return run_row.id;
end;
$$;

create or replace function public.fn_apply_clickup_lead_comment(
  p_organization_id uuid, p_workspace_id text, p_comment_id text,
  p_lead_id uuid, p_source_hash text, p_source_created_at timestamptz,
  p_source_updated_at timestamptz, p_parent_comment_id text,
  p_source_user_id text, p_author_display_name text, p_body_markdown text
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare existing public.clickup_comment_receipts%rowtype;
declare activity_id uuid := gen_random_uuid();
declare contact uuid;
begin
  if p_source_hash !~ '^[0-9a-f]{64}$'
     or length(btrim(p_workspace_id)) not between 1 and 255
     or length(btrim(p_comment_id)) not between 1 and 512
     or length(btrim(p_source_user_id)) not between 1 and 512
     or length(btrim(p_author_display_name)) not between 1 and 255
     or length(p_body_markdown) > 100000 then
    raise exception 'invalid_clickup_comment' using errcode = '22023';
  end if;
  select * into existing from public.clickup_comment_receipts
   where organization_id = p_organization_id and workspace_id = p_workspace_id
     and source_comment_id = p_comment_id for update;
  if found then
    if existing.source_hash <> p_source_hash then
      raise exception 'clickup_comment_create_only_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('result','unchanged','activity_id',existing.lead_activity_id);
  end if;
  select contact_id into contact from public.crm_leads
   where organization_id = p_organization_id and id = p_lead_id for share;
  if not found then raise exception 'clickup_comment_lead_not_found' using errcode = 'P0002'; end if;
  insert into public.crm_lead_activities (
    id, organization_id, lead_id, contact_id, source_module, source_id, type,
    payload, metadata, performed_at, actor_kind, reason
  ) values (
    activity_id, p_organization_id, p_lead_id, contact, 'clickup_import', activity_id,
    'clickup_comment_imported',
    jsonb_build_object('body_markdown', p_body_markdown),
    jsonb_strip_nulls(jsonb_build_object(
      'workspace_id', p_workspace_id, 'source_comment_id', p_comment_id,
      'parent_comment_id', p_parent_comment_id, 'source_user_id', p_source_user_id,
      'author_display_name', p_author_display_name, 'source_updated_at', p_source_updated_at
    )),
    p_source_created_at, 'system', 'Comentário histórico importado do ClickUp.'
  );
  insert into public.clickup_comment_receipts (
    organization_id, workspace_id, source_comment_id, source_hash, lead_activity_id
  ) values (p_organization_id, p_workspace_id, p_comment_id, p_source_hash, activity_id);
  return jsonb_build_object('result','created','activity_id',activity_id);
end;
$$;

create or replace function public.fn_apply_clickup_task_comment(
  p_organization_id uuid, p_workspace_id text, p_comment_id text,
  p_task_id uuid, p_parent_comment_id text, p_source_hash text,
  p_source_user_id text, p_author_display_name text, p_body_markdown text,
  p_source_created_at timestamptz, p_source_updated_at timestamptz
)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare existing public.clickup_comment_receipts%rowtype;
declare comment_row_id uuid := gen_random_uuid();
begin
  select * into existing from public.clickup_comment_receipts
   where organization_id = p_organization_id and workspace_id = p_workspace_id
     and source_comment_id = p_comment_id for update;
  if found then
    if existing.source_hash <> p_source_hash then
      raise exception 'clickup_comment_create_only_conflict' using errcode = 'PT409';
    end if;
    return jsonb_build_object('result','unchanged','task_comment_id',existing.task_comment_id);
  end if;
  insert into public.crm_task_comments (
    id, organization_id, task_id, workspace_id, source_comment_id,
    parent_source_comment_id, source_hash, source_user_id, author_display_name,
    body_markdown, source_created_at, source_updated_at
  ) values (
    comment_row_id, p_organization_id, p_task_id, p_workspace_id, p_comment_id,
    p_parent_comment_id, p_source_hash, p_source_user_id, p_author_display_name,
    p_body_markdown, p_source_created_at, p_source_updated_at
  );
  insert into public.clickup_comment_receipts (
    organization_id, workspace_id, source_comment_id, source_hash, task_comment_id
  ) values (p_organization_id, p_workspace_id, p_comment_id, p_source_hash, comment_row_id);
  return jsonb_build_object('result','created','task_comment_id',comment_row_id);
end;
$$;

create or replace function public.fn_stage_clickup_asset_sidecar(
  p_organization_id uuid, p_run_id uuid, p_created_by uuid, p_sidecar jsonb
)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare run_row public.clickup_import_runs%rowtype;
declare staged_sidecar_id uuid;
declare staged_mode text := p_sidecar->>'mode';
begin
  if jsonb_typeof(p_sidecar) <> 'object'
     or (p_sidecar->>'sidecar_version')::integer <> 1
     or (p_sidecar->>'manifest_version')::integer <> 3
     or staged_mode not in ('inventory','full')
     or jsonb_typeof(p_sidecar->'assets') <> 'array'
     or jsonb_typeof(p_sidecar->'comments') <> 'array' then
    raise exception 'invalid_clickup_asset_sidecar' using errcode = '22023';
  end if;
  select * into run_row from public.clickup_import_runs
   where organization_id = p_organization_id and id = p_run_id
     and status in ('preview','ready') and cancel_requested_at is null
     and exists (select 1 from public.organizations o
       where o.id = p_organization_id and o.status = 'active')
   for update;
  if not found then raise exception 'clickup_import_run_not_found' using errcode = 'P0002'; end if;
  if p_sidecar->>'run_id' <> p_run_id::text
     or p_sidecar->>'workspace_id' <> run_row.workspace_id
     or p_sidecar->>'snapshot_hash' <> run_row.snapshot_hash then
    raise exception 'clickup_asset_sidecar_binding_conflict' using errcode = 'PT409';
  end if;
  if staged_mode = 'full' and (
    (p_sidecar#>>'{coverage,tasks_expected}')::integer <> (
      select count(*) from public.clickup_import_items i
       where i.organization_id = p_organization_id and i.run_id = p_run_id
         and i.entity_type = 'task'
    )
    or (p_sidecar#>>'{coverage,tasks_comments_scanned}')::integer <>
       (p_sidecar#>>'{coverage,tasks_expected}')::integer
    or (p_sidecar#>>'{coverage,attachment_parents_scanned}')::integer <>
       (p_sidecar#>>'{coverage,tasks_expected}')::integer + (
         select count(distinct page_id.value)
           from public.clickup_import_items doc
           cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(doc.source_metadata->'page_ids')='array'
               then doc.source_metadata->'page_ids' else '[]'::jsonb end
           ) page_id(value)
          where doc.organization_id=p_organization_id and doc.run_id=p_run_id
            and doc.entity_type='doc'
       )
    or (p_sidecar#>>'{coverage,bytes_downloaded}')::bigint <> coalesce((
      select sum(coalesce((a->>'declared_size')::bigint, 0))
        from jsonb_array_elements(p_sidecar->'assets') a
    ), 0)
    or (p_sidecar#>>'{coverage,bytes_declared}')::bigint <>
       (p_sidecar#>>'{coverage,bytes_downloaded}')::bigint
    or (select count(*) from jsonb_array_elements(p_sidecar#>'{coverage,terminal_cursors}') c
         where c->>'kind' = 'tasks' and (c->>'terminal')::boolean) <>
       (p_sidecar#>>'{coverage,tasks_expected}')::integer
    or (select count(*) from jsonb_array_elements(p_sidecar#>'{coverage,terminal_cursors}') c
         where c->>'kind' = 'task_comments' and (c->>'terminal')::boolean) <>
       (p_sidecar#>>'{coverage,tasks_expected}')::integer
    or (select count(*) from jsonb_array_elements(p_sidecar#>'{coverage,terminal_cursors}') c
         where c->>'kind' = 'doc_pages' and (c->>'terminal')::boolean) <>
       (select count(distinct page_id.value)
          from public.clickup_import_items doc
          cross join lateral jsonb_array_elements_text(
            case when jsonb_typeof(doc.source_metadata->'page_ids')='array'
              then doc.source_metadata->'page_ids' else '[]'::jsonb end
          ) page_id(value)
         where doc.organization_id=p_organization_id and doc.run_id=p_run_id
           and doc.entity_type='doc')
    or exists (
      select 1 from public.clickup_import_items i
       where i.organization_id = p_organization_id and i.run_id = p_run_id
         and i.entity_type = 'task' and (
           not exists (select 1 from jsonb_array_elements(p_sidecar#>'{coverage,terminal_cursors}') c
             where c->>'kind' = 'tasks' and c->>'parent_external_id' = i.external_id
               and (c->>'terminal')::boolean)
           or not exists (select 1 from jsonb_array_elements(p_sidecar#>'{coverage,terminal_cursors}') c
             where c->>'kind' = 'task_comments' and c->>'parent_external_id' = i.external_id
               and (c->>'terminal')::boolean)
         )
    )
    or exists (
      select 1 from jsonb_array_elements(p_sidecar#>'{coverage,terminal_cursors}') c
       where c->>'kind' in ('tasks','task_comments') and not exists (
         select 1 from public.clickup_import_items i
          where i.organization_id = p_organization_id and i.run_id = p_run_id
            and i.entity_type = 'task' and i.external_id = c->>'parent_external_id'
       )
    )
    or exists (
      select 1
        from public.clickup_import_items doc
        cross join lateral jsonb_array_elements_text(
          case when jsonb_typeof(doc.source_metadata->'page_ids')='array'
            then doc.source_metadata->'page_ids' else '[]'::jsonb end
        ) page_id(value)
       where doc.organization_id=p_organization_id and doc.run_id=p_run_id
         and doc.entity_type='doc' and not exists (
           select 1 from jsonb_array_elements(p_sidecar#>'{coverage,terminal_cursors}') c
            where c->>'kind'='doc_pages' and (c->>'terminal')::boolean
              and c->>'parent_external_id'=page_id.value
         )
    )
    or exists (
      select 1 from jsonb_array_elements(p_sidecar#>'{coverage,terminal_cursors}') c
       where c->>'kind'='doc_pages' and (c->>'terminal')::boolean and not exists (
         select 1
           from public.clickup_import_items doc
           cross join lateral jsonb_array_elements_text(
             case when jsonb_typeof(doc.source_metadata->'page_ids')='array'
               then doc.source_metadata->'page_ids' else '[]'::jsonb end
           ) page_id(value)
          where doc.organization_id=p_organization_id and doc.run_id=p_run_id
            and doc.entity_type='doc' and page_id.value=c->>'parent_external_id'
       )
    )
  ) then
    raise exception 'clickup_sidecar_incomplete_coverage' using errcode = '22023';
  end if;
  if (run_row.scope = 'crm' and exists (
       select 1 from jsonb_array_elements(p_sidecar->'assets') a where a->>'parent_type' = 'doc_page'
     )) or (run_row.scope = 'docs' and exists (
       select 1 from jsonb_array_elements(p_sidecar->'assets') a where a->>'parent_type' = 'task'
     )) then
    raise exception 'clickup_asset_sidecar_scope_conflict' using errcode = 'PT409';
  end if;
  if run_row.scope = 'docs' and jsonb_array_length(p_sidecar->'comments') > 0 then
    raise exception 'clickup_comment_sidecar_scope_conflict' using errcode = 'PT409';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_sidecar->'assets') asset
     where (asset->>'parent_type'='doc_page' and nullif(asset->>'comment_id','') is not null)
        or (asset->>'parent_type'='task' and nullif(asset->>'comment_id','') is not null and not exists (
          select 1 from jsonb_array_elements(p_sidecar->'comments') comment
           where comment->>'comment_id'=asset->>'comment_id'
             and comment->>'task_id'=asset->>'parent_external_id'
             and exists (select 1 from jsonb_array_elements_text(comment->'attachment_ids') attachment_id(value)
               where attachment_id.value=asset->>'attachment_id')
        ))
  ) then
    raise exception 'clickup_asset_comment_binding_conflict' using errcode = 'PT409';
  end if;
  insert into public.clickup_asset_sidecars (
    organization_id, run_id, workspace_id, snapshot_hash, sidecar_version,
    manifest_version, mode, coverage, checkpoint, status, created_by
  ) values (
    p_organization_id, p_run_id, run_row.workspace_id, run_row.snapshot_hash, 1,
    3, staged_mode, p_sidecar->'coverage', p_sidecar->'checkpoint',
    case when staged_mode = 'inventory' then 'inventory' else 'ready' end, p_created_by
  )
  on conflict (organization_id, run_id) do update set
    checkpoint = excluded.checkpoint, updated_at = clock_timestamp()
  where clickup_asset_sidecars.snapshot_hash = excluded.snapshot_hash
    and clickup_asset_sidecars.mode = excluded.mode
    and clickup_asset_sidecars.coverage = excluded.coverage
  returning id into staged_sidecar_id;
  if staged_sidecar_id is null then
    raise exception 'clickup_asset_sidecar_create_only_conflict' using errcode = 'PT409';
  end if;
  insert into public.clickup_asset_items (
    organization_id, sidecar_id, run_id, workspace_id, attachment_id,
    parent_type, parent_external_id, comment_id, file_name, declared_size,
    sniffed_mime, source_sha256, upload_id, source_revision, status
  )
  select p_organization_id, staged_sidecar_id, p_run_id, run_row.workspace_id,
    asset->>'attachment_id', asset->>'parent_type', asset->>'parent_external_id',
    nullif(asset->>'comment_id',''), asset->>'file_name',
    nullif(asset->>'declared_size','')::bigint, nullif(asset->>'sniffed_mime',''),
    nullif(asset->>'sha256',''),
    case when staged_mode = 'full' then (asset->>'blob_ref')::uuid else null end,
    nullif(asset->>'source_revision',''),
    case when staged_mode = 'inventory' then 'inventory' else 'ready' end
  from jsonb_array_elements(p_sidecar->'assets') asset
  on conflict (organization_id, run_id, attachment_id) do nothing;
  if exists (
    select 1
      from jsonb_array_elements(p_sidecar->'assets') asset
      left join public.clickup_asset_items i
        on i.organization_id = p_organization_id and i.run_id = p_run_id
       and i.attachment_id = asset->>'attachment_id'
     where i.id is null
        or i.sidecar_id <> staged_sidecar_id
        or i.parent_type <> asset->>'parent_type'
        or i.parent_external_id <> asset->>'parent_external_id'
        or coalesce(i.comment_id, '') <> coalesce(asset->>'comment_id', '')
        or i.file_name <> asset->>'file_name'
        or i.declared_size is distinct from nullif(asset->>'declared_size','')::bigint
        or coalesce(i.sniffed_mime, '') <> coalesce(asset->>'sniffed_mime', '')
        or coalesce(i.source_sha256, '') <> coalesce(asset->>'sha256', '')
        or coalesce(i.source_revision, '') <> coalesce(asset->>'source_revision', '')
        or (staged_mode = 'full' and i.upload_id is distinct from (asset->>'blob_ref')::uuid)
  ) then
    raise exception 'clickup_asset_create_only_conflict' using errcode = 'PT409';
  end if;
  if staged_mode = 'full' and exists (
    select 1 from public.clickup_asset_items i
    left join public.clickup_asset_uploads u
      on u.organization_id = i.organization_id and u.id = i.upload_id and u.run_id = i.run_id
   where i.sidecar_id = staged_sidecar_id and (
     u.id is null or u.kind <> 'asset' or u.snapshot_hash <> run_row.snapshot_hash
     or u.attachment_id <> i.attachment_id or u.sha256 <> i.source_sha256
     or u.state not in ('prepared','uploaded') or u.expires_at <= clock_timestamp()
   )
  ) then
    raise exception 'clickup_asset_upload_binding_conflict' using errcode = 'PT409';
  end if;
  insert into public.clickup_import_items (
    organization_id, run_id, workspace_id, entity_type, external_id,
    parent_external_id, source_revision, source_hash, source_metadata,
    content_access, execution_blocked, blocked_reason, status
  )
  select p_organization_id, p_run_id, run_row.workspace_id, 'comment',
    comment->>'comment_id', comment->>'task_id', nullif(comment->>'source_updated_at',''),
    encode(extensions.digest(comment::text, 'sha256'), 'hex'), comment - 'body_markdown' ||
      jsonb_build_object('body_markdown', comment->>'body_markdown'),
    'none', false, null, 'ready'
  from jsonb_array_elements(p_sidecar->'comments') comment
  on conflict (organization_id, run_id, entity_type, external_id) do nothing;
  if exists (
    select 1
      from jsonb_array_elements(p_sidecar->'comments') comment
      left join public.clickup_import_items i
        on i.organization_id = p_organization_id and i.run_id = p_run_id
       and i.entity_type = 'comment' and i.external_id = comment->>'comment_id'
     where i.id is null
        or i.source_hash <> encode(extensions.digest(comment::text, 'sha256'), 'hex')
  ) then
    raise exception 'clickup_comment_create_only_conflict' using errcode = 'PT409';
  end if;
  if staged_mode='full' and not exists (
    select 1 from public.clickup_asset_items where sidecar_id=staged_sidecar_id
  ) then
    update public.clickup_asset_sidecars set status='completed',finished_at=clock_timestamp(),
      updated_at=clock_timestamp() where id=staged_sidecar_id;
  end if;
  return staged_sidecar_id;
end;
$$;

create or replace function public.fn_commit_clickup_asset(
  p_organization_id uuid,p_item_id uuid,p_claim_token uuid,p_target_kind text,p_target_id uuid,
  p_attachment_row_id uuid,p_mime_type text,p_file_size bigint,p_storage_path text
) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare i public.clickup_asset_items%rowtype; declare existing public.clickup_asset_receipts%rowtype;
declare actual_hash text; declare created boolean := false;
begin
  select ai.* into i from public.clickup_asset_items ai join public.clickup_import_runs r
    on r.organization_id=ai.organization_id and r.id=ai.run_id
   where ai.organization_id=p_organization_id and ai.id=p_item_id and ai.status='processing'
     and ai.claim_token=p_claim_token and ai.claimed_until>=clock_timestamp()
     and r.status='running' and r.cancel_requested_at is null for update of ai,r;
  if not found then raise exception 'clickup_asset_lease_lost' using errcode='PT409'; end if;
  if p_target_kind not in ('lead','task','knowledge') or p_file_size <> i.declared_size then
    raise exception 'clickup_asset_commit_shape_invalid' using errcode='22023';
  end if;
  if not exists (select 1 from public.clickup_object_mappings m where m.organization_id=p_organization_id
    and m.workspace_id=i.workspace_id and m.entity_type=i.parent_type and m.external_id=i.parent_external_id
    and ((p_target_kind='lead' and m.lead_id=p_target_id) or (p_target_kind='task' and m.task_id=p_target_id)
      or (p_target_kind='knowledge' and m.knowledge_source_id=p_target_id))) then
    raise exception 'clickup_asset_parent_not_mapped' using errcode='23503';
  end if;
  if i.comment_id is not null and not (
    (p_target_kind='lead' and exists (
      select 1 from public.clickup_comment_receipts cr
      join public.crm_lead_activities a on a.organization_id=cr.organization_id and a.id=cr.lead_activity_id
       where cr.organization_id=p_organization_id and cr.workspace_id=i.workspace_id
         and cr.source_comment_id=i.comment_id and a.lead_id=p_target_id
    )) or
    (p_target_kind='task' and exists (
      select 1 from public.clickup_comment_receipts cr
      join public.crm_task_comments c on c.organization_id=cr.organization_id and c.id=cr.task_comment_id
       where cr.organization_id=p_organization_id and cr.workspace_id=i.workspace_id
         and cr.source_comment_id=i.comment_id and c.task_id=p_target_id
    ))
  ) then
    raise exception 'clickup_asset_comment_target_conflict' using errcode='23503';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':asset:'||i.workspace_id||':'||i.attachment_id,0));
  select * into existing from public.clickup_asset_receipts where organization_id=p_organization_id
    and workspace_id=i.workspace_id and attachment_id=i.attachment_id for update;
  if found then
    if existing.source_sha256<>i.source_sha256 then raise exception 'clickup_asset_create_only_conflict' using errcode='PT409'; end if;
    return jsonb_build_object('result','unchanged');
  end if;
  if p_target_kind='lead' then
    insert into public.crm_lead_attachments(id,organization_id,lead_id,field_key,source_workspace_id,
      source_attachment_id,source_sha256,source_revision,source_comment_id,file_name,file_size,mime_type,storage_path)
    values(p_attachment_row_id,p_organization_id,p_target_id,'Anexos_ClickUp',i.workspace_id,i.attachment_id,
      i.source_sha256,i.source_revision,i.comment_id,i.file_name,p_file_size,p_mime_type,p_storage_path)
    on conflict do nothing;
    select source_sha256 into actual_hash from public.crm_lead_attachments where organization_id=p_organization_id and id=p_attachment_row_id;
    if actual_hash is distinct from i.source_sha256 then raise exception 'clickup_asset_create_only_conflict' using errcode='PT409'; end if;
    insert into public.clickup_asset_receipts(organization_id,workspace_id,attachment_id,source_sha256,lead_attachment_id)
      values(p_organization_id,i.workspace_id,i.attachment_id,i.source_sha256,p_attachment_row_id);
  elsif p_target_kind='task' then
    insert into public.crm_task_attachments(id,organization_id,task_id,workspace_id,source_attachment_id,
      source_sha256,source_revision,source_comment_id,file_name,file_size,mime_type,storage_path)
    values(p_attachment_row_id,p_organization_id,p_target_id,i.workspace_id,i.attachment_id,i.source_sha256,
      i.source_revision,i.comment_id,i.file_name,p_file_size,p_mime_type,p_storage_path) on conflict do nothing;
    select source_sha256 into actual_hash from public.crm_task_attachments where organization_id=p_organization_id and id=p_attachment_row_id;
    if actual_hash is distinct from i.source_sha256 then raise exception 'clickup_asset_create_only_conflict' using errcode='PT409'; end if;
    insert into public.clickup_asset_receipts(organization_id,workspace_id,attachment_id,source_sha256,task_attachment_id)
      values(p_organization_id,i.workspace_id,i.attachment_id,i.source_sha256,p_attachment_row_id);
  else
    insert into public.ai_knowledge_source_attachments(id,organization_id,knowledge_source_id,workspace_id,
      source_attachment_id,source_sha256,source_revision,source_comment_id,file_name,file_size,mime_type,storage_path)
    values(p_attachment_row_id,p_organization_id,p_target_id,i.workspace_id,i.attachment_id,i.source_sha256,
      i.source_revision,i.comment_id,i.file_name,p_file_size,p_mime_type,p_storage_path) on conflict do nothing;
    select source_sha256 into actual_hash from public.ai_knowledge_source_attachments where organization_id=p_organization_id and id=p_attachment_row_id;
    if actual_hash is distinct from i.source_sha256 then raise exception 'clickup_asset_create_only_conflict' using errcode='PT409'; end if;
    insert into public.clickup_asset_receipts(organization_id,workspace_id,attachment_id,source_sha256,knowledge_attachment_id)
      values(p_organization_id,i.workspace_id,i.attachment_id,i.source_sha256,p_attachment_row_id);
  end if;
  return jsonb_build_object('result','promoted','attachment_id',p_attachment_row_id);
end;
$$;

-- CREATE OR REPLACE preserva grants atuais, mas a migration repete a cerca
-- explicitamente para não depender de proteção implícita da cadeia anterior.
revoke execute on function public.fn_execute_clickup_import_run(uuid,uuid,integer,text,text,boolean)
  from public, anon, authenticated;
revoke execute on function public.fn_update_clickup_import_mapping(uuid,uuid,integer,jsonb,text)
  from public, anon, authenticated;
revoke execute on function public.fn_apply_clickup_lead_comment(uuid,text,text,uuid,text,timestamptz,timestamptz,text,text,text,text)
  from public, anon, authenticated;
revoke execute on function public.fn_apply_clickup_task_comment(uuid,text,text,uuid,text,text,text,text,text,timestamptz,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.fn_stage_clickup_asset_sidecar(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
revoke execute on function public.fn_commit_clickup_asset(uuid,uuid,uuid,text,uuid,uuid,text,bigint,text)
  from public, anon, authenticated;
