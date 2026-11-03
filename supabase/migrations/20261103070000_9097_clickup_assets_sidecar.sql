-- manifest: Adiciona sidecar seguro e idempotente para anexos ClickUp, com quarantine privada, leases, receipts e destinos tenant-safe em leads, tarefas e conhecimento.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'clickup-assets', 'clickup-assets', false, 10485760,
  array['application/pdf','text/plain','text/markdown','text/csv','image/png','image/jpeg','image/gif','image/webp']::text[]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('clickup-sidecars','clickup-sidecars',false,104857600,array['application/json']::text[])
on conflict (id) do update set public=false,file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

-- O envelope passa a reconhecer os objetos do sidecar. Conteúdo binário nunca
-- entra em source_payload: ele fica no bucket privado e é referenciado por upload_id.
alter table public.clickup_import_items
  drop constraint if exists clickup_import_items_entity_type_check;
alter table public.clickup_import_items
  add constraint clickup_import_items_entity_type_check check (
    entity_type in (
      'workspace','space','folder','list','task','doc','doc_page','user','status','custom_field',
      'comment','attachment'
    )
  );

alter table public.clickup_object_mappings
  drop constraint if exists clickup_object_mappings_entity_type_check;
alter table public.clickup_object_mappings
  add constraint clickup_object_mappings_entity_type_check check (
    entity_type in (
      'workspace','space','folder','list','task','doc','doc_page','user','status','custom_field',
      'comment','attachment'
    )
  );
alter table public.clickup_object_mappings
  drop constraint if exists clickup_object_mappings_entity_target_matrix_check;
alter table public.clickup_object_mappings
  add constraint clickup_object_mappings_entity_target_matrix_check check (
    (entity_type in ('workspace','space','folder') and pipeline_group_id is not null)
    or (entity_type = 'list' and pipeline_id is not null and field_key is null)
    or (entity_type = 'status' and stage_id is not null)
    or (entity_type = 'task' and (lead_id is not null or task_id is not null))
    or (entity_type = 'comment' and (lead_id is not null or task_id is not null))
    or (entity_type = 'attachment' and (lead_id is not null or task_id is not null or knowledge_source_id is not null))
    or (entity_type in ('doc','doc_page') and knowledge_source_id is not null)
    or (entity_type = 'custom_field' and pipeline_id is not null and field_key is not null)
  );

create unique index if not exists crm_leads_org_id_clickup_assets_uidx
  on public.crm_leads (organization_id, id);
create unique index if not exists crm_tasks_org_id_clickup_assets_uidx
  on public.crm_tasks (organization_id, id);
create unique index if not exists ai_knowledge_sources_org_id_clickup_assets_uidx
  on public.ai_knowledge_sources (organization_id, id);

-- O destino de lead já existe; acrescentamos tenant FK e identidade da origem.
alter table public.crm_lead_attachments
  add column if not exists source_workspace_id text,
  add column if not exists source_attachment_id text,
  add column if not exists source_sha256 text,
  add column if not exists source_revision text,
  add column if not exists source_comment_id text;
create unique index if not exists crm_lead_attachments_org_id_uidx
  on public.crm_lead_attachments (organization_id, id);
alter table public.crm_lead_attachments
  drop constraint if exists crm_lead_attachments_lead_org_fkey;
alter table public.crm_lead_attachments
  add constraint crm_lead_attachments_lead_org_fkey
  foreign key (organization_id, lead_id)
  references public.crm_leads (organization_id, id) on delete cascade;
alter table public.crm_lead_attachments
  drop constraint if exists crm_lead_attachments_clickup_identity_shape;
alter table public.crm_lead_attachments
  add constraint crm_lead_attachments_clickup_identity_shape check (
    (source_workspace_id is null and source_attachment_id is null and source_sha256 is null)
    or (
      source_workspace_id is not null and length(btrim(source_workspace_id)) between 1 and 255
      and source_attachment_id is not null and length(btrim(source_attachment_id)) between 1 and 512
      and source_sha256 ~ '^[0-9a-f]{64}$'
      and field_key = 'Anexos_ClickUp'
    )
  );
create unique index if not exists crm_lead_attachments_clickup_identity_uidx
  on public.crm_lead_attachments (organization_id, source_workspace_id, source_attachment_id)
  where source_attachment_id is not null;

-- A constraint antiga continua aceitando uploads manuais e passa a aceitar o
-- caminho determinístico ClickUp: org/workspace/alvo/hash.ext.
alter table public.crm_lead_attachments
  drop constraint if exists crm_lead_attachments_storage_path_check;
alter table public.crm_lead_attachments
  add constraint crm_lead_attachments_storage_path_check check (
    case
      when source_attachment_id is null then
        field_key ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
        and storage_path ~ (
          '^' || organization_id::text || '/leads/' || lead_id::text || '/' || field_key ||
          '/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
        )
      else
        storage_path ~ (
          '^' || organization_id::text || '/[A-Za-z0-9._-]+/leads/' || lead_id::text ||
          '/[0-9a-f]{64}\.[a-z0-9]+$'
        )
    end
  );

create table if not exists public.crm_task_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id uuid not null,
  workspace_id text not null,
  source_attachment_id text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_revision text,
  source_comment_id text,
  file_name text not null,
  file_size bigint not null check (file_size between 0 and 10485760),
  mime_type text not null,
  storage_path text not null,
  created_at timestamptz not null default now(),
  constraint crm_task_attachments_task_fkey foreign key (organization_id, task_id)
    references public.crm_tasks (organization_id, id) on delete cascade,
  constraint crm_task_attachments_source_shape check (
    length(btrim(workspace_id)) between 1 and 255
    and length(btrim(source_attachment_id)) between 1 and 512
    and storage_path ~ (
      '^' || organization_id::text || '/[A-Za-z0-9._-]+/tasks/' || task_id::text ||
      '/[0-9a-f]{64}\.[a-z0-9]+$'
    )
  ),
  unique (organization_id, workspace_id, source_attachment_id)
);
create unique index if not exists crm_task_attachments_org_id_uidx
  on public.crm_task_attachments (organization_id, id);
create index if not exists crm_task_attachments_parent_idx
  on public.crm_task_attachments (organization_id, task_id, created_at);

create table if not exists public.ai_knowledge_source_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  knowledge_source_id uuid not null,
  workspace_id text not null,
  source_attachment_id text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_revision text,
  source_comment_id text,
  file_name text not null,
  file_size bigint not null check (file_size between 0 and 10485760),
  mime_type text not null,
  storage_path text not null,
  indexed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ai_knowledge_source_attachments_source_fkey
    foreign key (organization_id, knowledge_source_id)
    references public.ai_knowledge_sources (organization_id, id) on delete cascade,
  constraint ai_knowledge_source_attachments_not_indexed check (indexed_at is null),
  constraint ai_knowledge_source_attachments_source_shape check (
    length(btrim(workspace_id)) between 1 and 255
    and length(btrim(source_attachment_id)) between 1 and 512
    and storage_path ~ (
      '^' || organization_id::text || '/[A-Za-z0-9._-]+/knowledge/' || knowledge_source_id::text ||
      '/[0-9a-f]{64}\.[a-z0-9]+$'
    )
  ),
  unique (organization_id, workspace_id, source_attachment_id)
);
create unique index if not exists ai_knowledge_source_attachments_org_id_uidx
  on public.ai_knowledge_source_attachments (organization_id, id);
create index if not exists ai_knowledge_source_attachments_parent_idx
  on public.ai_knowledge_source_attachments (organization_id, knowledge_source_id, created_at);

create table if not exists public.crm_task_comments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  task_id uuid not null,
  workspace_id text not null,
  source_comment_id text not null,
  parent_source_comment_id text,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  source_user_id text not null,
  author_display_name text not null,
  body_markdown text not null,
  source_created_at timestamptz not null,
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  constraint crm_task_comments_task_fkey foreign key (organization_id, task_id)
    references public.crm_tasks (organization_id, id) on delete cascade,
  constraint crm_task_comments_parent_fkey
    foreign key (organization_id, workspace_id, task_id, parent_source_comment_id)
    references public.crm_task_comments (organization_id, workspace_id, task_id, source_comment_id)
    on delete restrict,
  constraint crm_task_comments_shape check (
    length(btrim(workspace_id)) between 1 and 255
    and length(btrim(source_comment_id)) between 1 and 512
    and length(btrim(source_user_id)) between 1 and 512
    and length(btrim(author_display_name)) between 1 and 255
    and length(body_markdown) <= 100000
  ),
  unique (organization_id, workspace_id, source_comment_id),
  unique (organization_id, workspace_id, task_id, source_comment_id)
);
create unique index if not exists crm_task_comments_org_id_uidx
  on public.crm_task_comments (organization_id, id);
create index if not exists crm_task_comments_task_time_idx
  on public.crm_task_comments (organization_id, task_id, source_created_at, source_comment_id);
create unique index if not exists crm_lead_activities_org_id_clickup_uidx
  on public.crm_lead_activities (organization_id, id);

create table if not exists public.clickup_comment_receipts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workspace_id text not null,
  source_comment_id text not null,
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  lead_activity_id uuid,
  task_comment_id uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, workspace_id, source_comment_id),
  constraint clickup_comment_receipts_exact_target check (
    num_nonnulls(lead_activity_id, task_comment_id) = 1
  ),
  constraint clickup_comment_receipts_activity_fkey foreign key (organization_id, lead_activity_id)
    references public.crm_lead_activities (organization_id, id) on delete cascade,
  constraint clickup_comment_receipts_task_fkey foreign key (organization_id, task_comment_id)
    references public.crm_task_comments (organization_id, id) on delete cascade
);
alter table public.crm_task_attachments drop constraint if exists crm_task_attachments_comment_fkey;
alter table public.crm_task_attachments add constraint crm_task_attachments_comment_fkey
  foreign key (organization_id,workspace_id,task_id,source_comment_id)
  references public.crm_task_comments (organization_id,workspace_id,task_id,source_comment_id)
  on delete set null;
alter table public.crm_lead_attachments drop constraint if exists crm_lead_attachments_comment_fkey;
alter table public.crm_lead_attachments add constraint crm_lead_attachments_comment_fkey
  foreign key (organization_id,source_workspace_id,source_comment_id)
  references public.clickup_comment_receipts (organization_id,workspace_id,source_comment_id)
  on delete set null;

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
      raise exception 'clickup_comment_create_only_conflict' using errcode = '40001';
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
      raise exception 'clickup_comment_create_only_conflict' using errcode = '40001';
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

create table if not exists public.clickup_asset_sidecars (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  workspace_id text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  sidecar_version integer not null check (sidecar_version = 1),
  manifest_version integer not null check (manifest_version = 3),
  mode text not null check (mode in ('inventory','full')),
  coverage jsonb not null check (jsonb_typeof(coverage) = 'object'),
  checkpoint jsonb not null check (jsonb_typeof(checkpoint) = 'object'),
  status text not null default 'ready' check (
    status in ('inventory','ready','running','completed','completed_with_errors','cancelled')
  ),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint clickup_asset_sidecars_run_fkey foreign key (organization_id, run_id, workspace_id)
    references public.clickup_import_runs (organization_id, id, workspace_id) on delete cascade,
  unique (organization_id, run_id),
  unique (organization_id, id, run_id)
);

create table if not exists public.clickup_asset_uploads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  workspace_id text not null,
  snapshot_hash text not null check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('sidecar','asset')),
  attachment_id text,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  declared_size bigint not null,
  storage_path text not null unique,
  state text not null default 'prepared' check (state in ('prepared','uploaded','consumed','expired')),
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clickup_asset_uploads_run_fkey foreign key (organization_id, run_id, workspace_id)
    references public.clickup_import_runs (organization_id, id, workspace_id) on delete cascade,
  constraint clickup_asset_uploads_shape check (
    expires_at > created_at and expires_at <= created_at + interval '1 day'
    and ((kind = 'asset' and declared_size between 1 and 10485760)
      or (kind = 'sidecar' and declared_size between 1 and 104857600))
    and ((kind = 'sidecar' and attachment_id is null) or
         (kind = 'asset' and attachment_id is not null and length(btrim(attachment_id)) between 1 and 512))
    and storage_path ~ (
      '^quarantine/' || organization_id::text || '/' || run_id::text ||
      '/[0-9a-f]{64}/[0-9a-f-]{36}/[0-9a-f]{64}$'
    )
  ),
  unique (organization_id, id, run_id)
);
create index if not exists clickup_asset_uploads_expiry_idx
  on public.clickup_asset_uploads (state, expires_at) where state in ('prepared','uploaded','consumed');

create table if not exists public.clickup_asset_items (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  sidecar_id uuid not null,
  run_id uuid not null,
  workspace_id text not null,
  attachment_id text not null,
  parent_type text not null check (parent_type in ('task','doc_page')),
  parent_external_id text not null,
  comment_id text,
  file_name text not null,
  declared_size bigint check (declared_size between 0 and 10485760),
  sniffed_mime text,
  source_sha256 text,
  upload_id uuid,
  source_revision text,
  status text not null check (
    status in ('inventory','ready','processing','retry_wait','promoted','unchanged','skipped','conflict','failed','cancelled')
  ),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz,
  claim_token uuid,
  claimed_until timestamptz,
  final_storage_path text,
  error_code text,
  error_message text check (error_message is null or length(error_message) <= 500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clickup_asset_items_sidecar_fkey foreign key (organization_id, sidecar_id, run_id)
    references public.clickup_asset_sidecars (organization_id, id, run_id) on delete cascade,
  constraint clickup_asset_items_upload_fkey foreign key (organization_id, upload_id, run_id)
    references public.clickup_asset_uploads (organization_id, id, run_id) on delete restrict,
  constraint clickup_asset_items_shape check (
    length(btrim(attachment_id)) between 1 and 512
    and length(btrim(parent_external_id)) between 1 and 512
    and (
      (status = 'inventory' and sniffed_mime is null and source_sha256 is null and upload_id is null)
      or (status <> 'inventory' and sniffed_mime is not null and source_sha256 ~ '^[0-9a-f]{64}$' and upload_id is not null)
    )
    and ((status = 'processing' and claim_token is not null and claimed_until is not null)
      or (status <> 'processing' and claim_token is null and claimed_until is null))
    and ((status = 'retry_wait' and next_attempt_at is not null)
      or (status <> 'retry_wait' and next_attempt_at is null))
  ),
  unique (organization_id, run_id, attachment_id)
);
create index if not exists clickup_asset_items_claim_idx
  on public.clickup_asset_items (status, next_attempt_at, created_at, id)
  where status in ('ready','processing','retry_wait');

create table if not exists public.clickup_asset_receipts (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  workspace_id text not null,
  attachment_id text not null,
  source_sha256 text not null check (source_sha256 ~ '^[0-9a-f]{64}$'),
  lead_attachment_id uuid,
  task_attachment_id uuid,
  knowledge_attachment_id uuid,
  created_at timestamptz not null default now(),
  primary key (organization_id, workspace_id, attachment_id),
  constraint clickup_asset_receipts_exact_target check (
    num_nonnulls(lead_attachment_id, task_attachment_id, knowledge_attachment_id) = 1
  ),
  constraint clickup_asset_receipts_lead_fkey foreign key (organization_id, lead_attachment_id)
    references public.crm_lead_attachments (organization_id, id) on delete cascade,
  constraint clickup_asset_receipts_task_fkey foreign key (organization_id, task_attachment_id)
    references public.crm_task_attachments (organization_id, id) on delete cascade,
  constraint clickup_asset_receipts_knowledge_fkey foreign key (organization_id, knowledge_attachment_id)
    references public.ai_knowledge_source_attachments (organization_id, id) on delete cascade
);

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
    raise exception 'clickup_asset_sidecar_binding_conflict' using errcode = '40001';
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
    raise exception 'clickup_asset_sidecar_scope_conflict' using errcode = '40001';
  end if;
  if run_row.scope = 'docs' and jsonb_array_length(p_sidecar->'comments') > 0 then
    raise exception 'clickup_comment_sidecar_scope_conflict' using errcode = '40001';
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
    raise exception 'clickup_asset_comment_binding_conflict' using errcode = '40001';
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
    raise exception 'clickup_asset_sidecar_create_only_conflict' using errcode = '40001';
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
    raise exception 'clickup_asset_create_only_conflict' using errcode = '40001';
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
    raise exception 'clickup_asset_upload_binding_conflict' using errcode = '40001';
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
    raise exception 'clickup_comment_create_only_conflict' using errcode = '40001';
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

create or replace function public.fn_claim_clickup_asset(
  p_worker_id uuid, p_lease_seconds integer default 90
)
returns public.clickup_asset_items
language plpgsql security definer set search_path = public, pg_temp as $$
declare claimed public.clickup_asset_items%rowtype;
begin
  if p_worker_id is null or p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_asset_lease' using errcode = '22023';
  end if;
  update public.clickup_asset_items i
     set status = 'cancelled', claim_token = null, claimed_until = null,
         next_attempt_at = null, error_code = 'run_cancelled', updated_at = clock_timestamp()
    from public.clickup_import_runs r
   where r.id = i.run_id and r.organization_id = i.organization_id
     and r.cancel_requested_at is not null
     and i.status in ('ready','processing','retry_wait');
  update public.clickup_asset_sidecars s set status='cancelled',finished_at=clock_timestamp(),
    updated_at=clock_timestamp()
   where s.status in ('ready','running')
     and exists (select 1 from public.clickup_import_runs r
       where r.organization_id=s.organization_id and r.id=s.run_id and r.cancel_requested_at is not null)
     and not exists (select 1 from public.clickup_asset_items i
       where i.sidecar_id=s.id and i.status in ('ready','processing','retry_wait'));
  with expired as (
    select id from public.clickup_asset_items
     where status = 'processing' and claimed_until < clock_timestamp()
     order by claimed_until, id for update skip locked limit 100
  )
  update public.clickup_asset_items i
     set status = case when attempts < max_attempts then 'retry_wait' else 'failed' end,
         next_attempt_at = case when attempts < max_attempts then clock_timestamp() else null end,
         claim_token = null, claimed_until = null, error_code = 'lease_expired',
         error_message = 'O processamento do anexo expirou e pode ser retomado.',
         updated_at = clock_timestamp()
   where i.id in (select id from expired);
  update public.clickup_asset_items i set status='skipped',next_attempt_at=null,
    claim_token=null,claimed_until=null,error_code='skipped_parent_not_imported',
    error_message='A origem pai ou o comentário foi ignorado intencionalmente.',
    updated_at=clock_timestamp()
   where i.status in ('ready','retry_wait')
     and exists (select 1 from public.clickup_import_runs r
       where r.organization_id=i.organization_id and r.id=i.run_id
         and r.status='running' and r.cancel_requested_at is null)
     and (
       (not exists (select 1 from public.clickup_object_mappings m
          where m.organization_id=i.organization_id and m.workspace_id=i.workspace_id
            and m.entity_type=i.parent_type and m.external_id=i.parent_external_id)
        and exists (select 1 from public.clickup_import_items source
          where source.organization_id=i.organization_id and source.run_id=i.run_id
            and source.status='skipped'
            and ((i.parent_type='task' and source.entity_type='task'
                   and source.external_id=i.parent_external_id)
              or (i.parent_type='doc_page' and source.entity_type='doc'
                   and exists (select 1 from jsonb_array_elements_text(
                     case when jsonb_typeof(source.source_metadata->'page_ids')='array'
                       then source.source_metadata->'page_ids' else '[]'::jsonb end
                   ) page_id(value) where page_id.value=i.parent_external_id)))))
       or (i.comment_id is not null and exists (
         select 1 from public.clickup_import_items source_comment
          where source_comment.organization_id=i.organization_id
            and source_comment.run_id=i.run_id and source_comment.entity_type='comment'
            and source_comment.external_id=i.comment_id and source_comment.status='skipped'))
     );
  update public.clickup_asset_items i set status='failed',next_attempt_at=null,
    claim_token=null,claimed_until=null,error_code='blocked_parent_not_applied',
    error_message='A origem pai ou o comentário terminou sem destino aplicado.',
    updated_at=clock_timestamp()
   where i.status in ('ready','retry_wait')
     and exists (select 1 from public.clickup_import_runs r
       where r.organization_id=i.organization_id and r.id=i.run_id
         and r.status='running' and r.cancel_requested_at is null)
     and (
       (
         not exists (select 1 from public.clickup_object_mappings m
           where m.organization_id=i.organization_id and m.workspace_id=i.workspace_id
             and m.entity_type=i.parent_type and m.external_id=i.parent_external_id)
         and exists (select 1 from public.clickup_import_items source
           where source.organization_id=i.organization_id and source.run_id=i.run_id
             and source.status in ('succeeded','failed','cancelled','blocked')
             and ((i.parent_type='task' and source.entity_type='task'
                    and source.external_id=i.parent_external_id)
               or (i.parent_type='doc_page' and source.entity_type='doc'
                    and exists (select 1 from jsonb_array_elements_text(
                      case when jsonb_typeof(source.source_metadata->'page_ids')='array'
                        then source.source_metadata->'page_ids' else '[]'::jsonb end
                    ) page_id(value) where page_id.value=i.parent_external_id)))
         )
       )
       or (
         i.comment_id is not null
         and exists (select 1 from public.clickup_import_items source_comment
           where source_comment.organization_id=i.organization_id
             and source_comment.run_id=i.run_id and source_comment.entity_type='comment'
             and source_comment.external_id=i.comment_id
             and source_comment.status in ('succeeded','failed','cancelled','blocked'))
         and not exists (select 1 from public.clickup_object_mappings m
           where m.organization_id=i.organization_id and m.workspace_id=i.workspace_id
             and m.entity_type=i.parent_type and m.external_id=i.parent_external_id
             and ((m.lead_id is not null and exists (
               select 1 from public.clickup_comment_receipts cr
               join public.crm_lead_activities a
                 on a.organization_id=cr.organization_id and a.id=cr.lead_activity_id
                where cr.organization_id=i.organization_id and cr.workspace_id=i.workspace_id
                  and cr.source_comment_id=i.comment_id and a.lead_id=m.lead_id
             )) or (m.task_id is not null and exists (
               select 1 from public.clickup_comment_receipts cr
               join public.crm_task_comments c
                 on c.organization_id=cr.organization_id and c.id=cr.task_comment_id
                where cr.organization_id=i.organization_id and cr.workspace_id=i.workspace_id
                  and cr.source_comment_id=i.comment_id and c.task_id=m.task_id
             )))
         )
       )
     );
  update public.clickup_asset_sidecars s set status='completed_with_errors',
    finished_at=clock_timestamp(),updated_at=clock_timestamp()
   where s.status in ('ready','running')
     and exists (select 1 from public.clickup_asset_items i where i.sidecar_id=s.id
       and i.status='failed' and i.error_code='blocked_parent_not_applied')
     and not exists (select 1 from public.clickup_asset_items i where i.sidecar_id=s.id
       and i.status in ('ready','processing','retry_wait'));
  update public.clickup_asset_sidecars s set status='completed',finished_at=clock_timestamp(),
    updated_at=clock_timestamp()
   where s.mode='full' and s.status in ('ready','running')
     and exists (select 1 from public.clickup_asset_items i where i.sidecar_id=s.id)
     and not exists (select 1 from public.clickup_asset_items i where i.sidecar_id=s.id
       and i.status in ('ready','processing','retry_wait','failed','conflict'));
  perform set_config('deskcomm.clickup_transition','finish',true);
  update public.clickup_import_runs r set status=case when
      exists (select 1 from public.clickup_import_items source
        where source.organization_id=r.organization_id and source.run_id=r.id
          and source.status='failed')
      or exists (select 1 from public.clickup_asset_items i
        where i.organization_id=r.organization_id and i.run_id=r.id
          and i.status in ('failed','conflict'))
      then 'completed_with_errors' else 'completed' end,
    finished_at=clock_timestamp(),
    lease_owner=null,lease_token=null,lease_expires_at=null,heartbeat_at=null,
    updated_at=clock_timestamp()
   where r.status='running' and r.cancel_requested_at is null
     and exists (select 1 from public.clickup_asset_items i where i.organization_id=r.organization_id
       and i.run_id=r.id and i.error_code in ('blocked_parent_not_applied','skipped_parent_not_imported'))
     and not exists (select 1 from public.clickup_import_items source
       where source.organization_id=r.organization_id and source.run_id=r.id
         and not source.execution_blocked
         and source.status not in ('succeeded','failed','skipped','cancelled'))
     and not exists (select 1 from public.clickup_asset_items i
       where i.organization_id=r.organization_id and i.run_id=r.id
         and i.status in ('ready','processing','retry_wait'));
  select i.* into claimed
    from public.clickup_asset_items i
    join public.clickup_asset_sidecars s on s.id = i.sidecar_id and s.organization_id = i.organization_id
    join public.clickup_import_runs r on r.id = i.run_id and r.organization_id = i.organization_id
    join public.organizations o on o.id = i.organization_id and o.status = 'active'
   where s.mode = 'full' and s.status in ('ready','running')
     and r.status = 'running' and r.cancel_requested_at is null
     and exists (select 1 from public.clickup_object_mappings m
       where m.organization_id=i.organization_id and m.workspace_id=i.workspace_id
         and m.entity_type=i.parent_type and m.external_id=i.parent_external_id
         and (i.comment_id is null
           or (m.lead_id is not null and exists (
             select 1 from public.clickup_comment_receipts cr
             join public.crm_lead_activities a
               on a.organization_id=cr.organization_id and a.id=cr.lead_activity_id
              where cr.organization_id=i.organization_id and cr.workspace_id=i.workspace_id
                and cr.source_comment_id=i.comment_id and a.lead_id=m.lead_id
           ))
           or (m.task_id is not null and exists (
             select 1 from public.clickup_comment_receipts cr
             join public.crm_task_comments c
               on c.organization_id=cr.organization_id and c.id=cr.task_comment_id
              where cr.organization_id=i.organization_id and cr.workspace_id=i.workspace_id
                and cr.source_comment_id=i.comment_id and c.task_id=m.task_id
           )))
     )
     and (i.status = 'ready' or (i.status = 'retry_wait' and i.next_attempt_at <= clock_timestamp()))
   order by i.created_at, i.id for update of i skip locked limit 1;
  if not found then return null; end if;
  update public.clickup_asset_items
     set status = 'processing', attempts = attempts + 1, claim_token = gen_random_uuid(),
         claimed_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
         next_attempt_at = null, error_code = null, error_message = null,
         updated_at = clock_timestamp()
   where id = claimed.id returning * into claimed;
  update public.clickup_asset_sidecars set status = 'running', updated_at = clock_timestamp()
   where id = claimed.sidecar_id and status = 'ready';
  return claimed;
end;
$$;

create or replace function public.fn_heartbeat_clickup_asset(
  p_organization_id uuid, p_asset_id uuid, p_claim_token uuid,
  p_lease_seconds integer default 90
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_lease_seconds not between 15 and 900 then
    raise exception 'invalid_clickup_asset_lease' using errcode = '22023';
  end if;
  update public.clickup_asset_items i
     set claimed_until = clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = clock_timestamp()
   where i.organization_id = p_organization_id and i.id = p_asset_id
     and i.status = 'processing' and i.claim_token = p_claim_token
     and i.claimed_until >= clock_timestamp()
     and exists (select 1 from public.clickup_import_runs r
       where r.organization_id = i.organization_id and r.id = i.run_id
         and r.cancel_requested_at is null);
  return found;
end;
$$;

create or replace function public.fn_finish_clickup_asset(
  p_organization_id uuid, p_asset_id uuid, p_claim_token uuid,
  p_outcome text, p_retry_at timestamptz default null,
  p_error_code text default null, p_error_message text default null,
  p_final_storage_path text default null
)
returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare sidecar uuid; declare affected_run uuid; declare run_cancelled boolean;
begin
  if p_outcome not in ('promoted','unchanged','skipped','conflict','failed','retry_wait','cancelled') then
    raise exception 'invalid_clickup_asset_outcome' using errcode = '22023';
  end if;
  select i.run_id,(r.cancel_requested_at is not null or r.status <> 'running')
    into affected_run,run_cancelled from public.clickup_asset_items i
    join public.clickup_import_runs r on r.organization_id=i.organization_id and r.id=i.run_id
   where i.organization_id=p_organization_id and i.id=p_asset_id and i.status='processing'
     and i.claim_token=p_claim_token and i.claimed_until>=clock_timestamp() for update of i,r;
  if not found then return false; end if;
  if run_cancelled then
    update public.clickup_asset_items set status='cancelled',next_attempt_at=null,claim_token=null,
      claimed_until=null,error_code='run_cancelled',error_message=null,updated_at=clock_timestamp()
     where organization_id=p_organization_id and id=p_asset_id returning sidecar_id into sidecar;
    update public.clickup_asset_sidecars s set status='cancelled',finished_at=clock_timestamp(),
      updated_at=clock_timestamp() where s.id=sidecar and s.status in ('ready','running')
      and not exists (select 1 from public.clickup_asset_items i where i.sidecar_id=s.id
        and i.status in ('ready','processing','retry_wait'));
    return false;
  else
  update public.clickup_asset_items i set
    status = p_outcome,
    next_attempt_at = case when p_outcome = 'retry_wait' then p_retry_at else null end,
    claim_token = null, claimed_until = null,
    error_code = p_error_code,
    error_message = left(p_error_message, 500),
    final_storage_path = coalesce(p_final_storage_path, final_storage_path),
    updated_at = clock_timestamp()
   where i.organization_id = p_organization_id and i.id = p_asset_id
     and i.status = 'processing' and i.claim_token = p_claim_token
     and i.claimed_until >= clock_timestamp()
   returning sidecar_id into sidecar;
  end if;
  if not found then return false; end if;
  if not exists (
    select 1 from public.clickup_asset_items
     where sidecar_id = sidecar and status in ('ready','processing','retry_wait')
  ) then
    update public.clickup_asset_sidecars s set
      status = case when exists (select 1 from public.clickup_asset_items i
        where i.sidecar_id = s.id and i.status in ('failed','conflict'))
        then 'completed_with_errors' else 'completed' end,
      finished_at = clock_timestamp(), updated_at = clock_timestamp()
     where s.id = sidecar and s.status in ('ready','running');
  end if;
  if not run_cancelled and not exists (select 1 from public.clickup_import_items i
    where i.organization_id=p_organization_id and i.run_id=affected_run and not i.execution_blocked
      and i.status not in ('succeeded','failed','skipped','cancelled'))
    and not exists (select 1 from public.clickup_asset_items i where i.organization_id=p_organization_id
      and i.run_id=affected_run and i.status in ('ready','processing','retry_wait')) then
    perform set_config('deskcomm.clickup_transition','finish',true);
    update public.clickup_import_runs r set status=case when
      exists (select 1 from public.clickup_import_items i where i.organization_id=p_organization_id
        and i.run_id=affected_run and i.status='failed') or
      exists (select 1 from public.clickup_asset_items i where i.organization_id=p_organization_id
        and i.run_id=affected_run and i.status in ('failed','conflict'))
      then 'completed_with_errors' else 'completed' end,
      finished_at=clock_timestamp(),lease_owner=null,lease_token=null,lease_expires_at=null,
      heartbeat_at=null,updated_at=clock_timestamp()
     where r.organization_id=p_organization_id and r.id=affected_run and r.status='running'
       and r.cancel_requested_at is null;
  end if;
  return true;
end;
$$;

create or replace function public.fn_expurgar_clickup_asset_staging(p_limite integer default 500)
returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare affected integer;
begin
  with expired as (
    select id, organization_id, storage_path, kind
      from public.clickup_asset_uploads
     where state in ('prepared','uploaded','consumed') and expires_at < clock_timestamp()
     order by expires_at, id limit greatest(1, least(coalesce(p_limite, 500), 5000))
     for update skip locked
  ), queued as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path, status)
    select organization_id, case kind when 'sidecar' then 'clickup-sidecars' else 'clickup-assets' end,
      storage_path, 'pending' from expired
    on conflict (bucket, object_path) do nothing returning object_path
  )
  update public.clickup_asset_uploads u set state = 'expired', updated_at = clock_timestamp()
   where u.id in (select id from expired);
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function public.fn_queue_clickup_quarantine_cleanup(
  p_organization_id uuid,p_upload_id uuid
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare upload public.clickup_asset_uploads%rowtype;
begin
  select * into upload from public.clickup_asset_uploads
   where organization_id=p_organization_id and id=p_upload_id and state='consumed' for update;
  if not found then return false; end if;
  insert into public.storage_redaction_queue(organization_id,bucket,object_path,status)
  values(upload.organization_id,case upload.kind when 'sidecar' then 'clickup-sidecars' else 'clickup-assets' end,
    upload.storage_path,'pending')
  on conflict(bucket,object_path) do update set status='pending',processed_at=null,error_message=null;
  return true;
end;
$$;

create or replace function public.fn_guard_clickup_attachment_quota()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare current_count bigint; declare current_bytes bigint; declare target_id uuid;
begin
  if tg_table_name = 'crm_lead_attachments' and new.source_attachment_id is null then return new; end if;
  if tg_table_name = 'crm_lead_attachments' then target_id := new.lead_id;
  elsif tg_table_name = 'crm_task_attachments' then target_id := new.task_id;
  else target_id := new.knowledge_source_id;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':' || tg_table_name || ':' || target_id::text, 0));
  if tg_table_name = 'crm_lead_attachments' then
    if exists (select 1 from public.crm_lead_attachments a where a.organization_id=new.organization_id
      and a.source_workspace_id=new.source_workspace_id and a.source_attachment_id=new.source_attachment_id) then return new; end if;
    select count(*),coalesce(sum(file_size),0) into current_count,current_bytes from public.crm_lead_attachments
      where organization_id=new.organization_id and lead_id=target_id and source_attachment_id is not null;
  elsif tg_table_name = 'crm_task_attachments' then
    if exists (select 1 from public.crm_task_attachments a where a.organization_id=new.organization_id
      and a.workspace_id=new.workspace_id and a.source_attachment_id=new.source_attachment_id) then return new; end if;
    select count(*),coalesce(sum(file_size),0) into current_count,current_bytes from public.crm_task_attachments
      where organization_id=new.organization_id and task_id=target_id;
  else
    if exists (select 1 from public.ai_knowledge_source_attachments a where a.organization_id=new.organization_id
      and a.workspace_id=new.workspace_id and a.source_attachment_id=new.source_attachment_id) then return new; end if;
    select count(*),coalesce(sum(file_size),0) into current_count,current_bytes from public.ai_knowledge_source_attachments
      where organization_id=new.organization_id and knowledge_source_id=target_id;
  end if;
  if current_count >= 20 then raise exception 'clickup_asset_target_count_limit' using errcode='23514'; end if;
  if current_bytes + new.file_size > 52428800 then raise exception 'clickup_asset_target_bytes_limit' using errcode='23514'; end if;
  return new;
end;
$$;

create or replace function public.fn_queue_clickup_asset_delete()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.crm_lead_attachments where storage_path=old.storage_path)
    or exists (select 1 from public.crm_task_attachments where storage_path=old.storage_path)
    or exists (select 1 from public.ai_knowledge_source_attachments where storage_path=old.storage_path) then
    return old;
  end if;
  insert into public.storage_redaction_queue (organization_id,bucket,object_path,status)
  values (old.organization_id,case when tg_table_name='crm_lead_attachments' and old.source_attachment_id is null
    then 'internal-media' else 'clickup-assets' end,old.storage_path,'pending')
  on conflict (bucket,object_path) do update set status='pending',processed_at=null,error_message=null;
  return old;
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
  if not found then raise exception 'clickup_asset_lease_lost' using errcode='40001'; end if;
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
    if existing.source_sha256<>i.source_sha256 then raise exception 'clickup_asset_create_only_conflict' using errcode='40001'; end if;
    return jsonb_build_object('result','unchanged');
  end if;
  if p_target_kind='lead' then
    insert into public.crm_lead_attachments(id,organization_id,lead_id,field_key,source_workspace_id,
      source_attachment_id,source_sha256,source_revision,source_comment_id,file_name,file_size,mime_type,storage_path)
    values(p_attachment_row_id,p_organization_id,p_target_id,'Anexos_ClickUp',i.workspace_id,i.attachment_id,
      i.source_sha256,i.source_revision,i.comment_id,i.file_name,p_file_size,p_mime_type,p_storage_path)
    on conflict do nothing;
    select source_sha256 into actual_hash from public.crm_lead_attachments where organization_id=p_organization_id and id=p_attachment_row_id;
    if actual_hash is distinct from i.source_sha256 then raise exception 'clickup_asset_create_only_conflict' using errcode='40001'; end if;
    insert into public.clickup_asset_receipts(organization_id,workspace_id,attachment_id,source_sha256,lead_attachment_id)
      values(p_organization_id,i.workspace_id,i.attachment_id,i.source_sha256,p_attachment_row_id);
  elsif p_target_kind='task' then
    insert into public.crm_task_attachments(id,organization_id,task_id,workspace_id,source_attachment_id,
      source_sha256,source_revision,source_comment_id,file_name,file_size,mime_type,storage_path)
    values(p_attachment_row_id,p_organization_id,p_target_id,i.workspace_id,i.attachment_id,i.source_sha256,
      i.source_revision,i.comment_id,i.file_name,p_file_size,p_mime_type,p_storage_path) on conflict do nothing;
    select source_sha256 into actual_hash from public.crm_task_attachments where organization_id=p_organization_id and id=p_attachment_row_id;
    if actual_hash is distinct from i.source_sha256 then raise exception 'clickup_asset_create_only_conflict' using errcode='40001'; end if;
    insert into public.clickup_asset_receipts(organization_id,workspace_id,attachment_id,source_sha256,task_attachment_id)
      values(p_organization_id,i.workspace_id,i.attachment_id,i.source_sha256,p_attachment_row_id);
  else
    insert into public.ai_knowledge_source_attachments(id,organization_id,knowledge_source_id,workspace_id,
      source_attachment_id,source_sha256,source_revision,source_comment_id,file_name,file_size,mime_type,storage_path)
    values(p_attachment_row_id,p_organization_id,p_target_id,i.workspace_id,i.attachment_id,i.source_sha256,
      i.source_revision,i.comment_id,i.file_name,p_file_size,p_mime_type,p_storage_path) on conflict do nothing;
    select source_sha256 into actual_hash from public.ai_knowledge_source_attachments where organization_id=p_organization_id and id=p_attachment_row_id;
    if actual_hash is distinct from i.source_sha256 then raise exception 'clickup_asset_create_only_conflict' using errcode='40001'; end if;
    insert into public.clickup_asset_receipts(organization_id,workspace_id,attachment_id,source_sha256,knowledge_attachment_id)
      values(p_organization_id,i.workspace_id,i.attachment_id,i.source_sha256,p_attachment_row_id);
  end if;
  return jsonb_build_object('result','promoted','attachment_id',p_attachment_row_id);
end;
$$;

create or replace function public.fn_queue_clickup_asset_orphan(
  p_organization_id uuid,p_storage_path text
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if p_storage_path !~ ('^'||p_organization_id::text||'/[A-Za-z0-9._-]+/(leads|tasks|knowledge)/[0-9a-f-]{36}/[0-9a-f]{64}\.[a-z0-9]+$') then
    raise exception 'clickup_asset_orphan_path_invalid' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('clickup-asset-path:'||p_storage_path,0));
  if exists (select 1 from public.crm_lead_attachments where organization_id=p_organization_id and storage_path=p_storage_path)
    or exists (select 1 from public.crm_task_attachments where organization_id=p_organization_id and storage_path=p_storage_path)
    or exists (select 1 from public.ai_knowledge_source_attachments where organization_id=p_organization_id and storage_path=p_storage_path) then
    return false;
  end if;
  insert into public.storage_redaction_queue(organization_id,bucket,object_path,status)
  values(p_organization_id,'clickup-assets',p_storage_path,'pending')
  on conflict(bucket,object_path) do update set status='pending',processed_at=null,error_message=null;
  return true;
end;
$$;

create or replace function public.fn_reconcile_clickup_asset_orphans(p_limite integer default 500)
returns integer language plpgsql security definer set search_path=public,storage,pg_temp as $$
declare affected integer;
begin
  with candidates as (
    select o.name, org.id organization_id
      from storage.objects o
      join public.organizations org on org.id::text=split_part(o.name,'/',1)
     where o.bucket_id='clickup-assets' and o.created_at < clock_timestamp()-interval '1 hour'
       and o.name ~ ('^'||org.id::text||'/[0-9a-f]{32}/(leads|tasks|knowledge)/[0-9a-f-]{36}/[0-9a-f]{64}\.[a-z0-9]+$')
       and not exists (select 1 from public.crm_lead_attachments a
         where a.organization_id=org.id and a.storage_path=o.name)
       and not exists (select 1 from public.crm_task_attachments a
         where a.organization_id=org.id and a.storage_path=o.name)
       and not exists (select 1 from public.ai_knowledge_source_attachments a
         where a.organization_id=org.id and a.storage_path=o.name)
     order by o.created_at,o.name
     limit greatest(1,least(coalesce(p_limite,500),5000))
  )
  insert into public.storage_redaction_queue(organization_id,bucket,object_path,status)
  select organization_id,'clickup-assets',name,'pending' from candidates
  on conflict(bucket,object_path) do update set status='pending',processed_at=null,error_message=null;
  get diagnostics affected=row_count;
  return affected;
end;
$$;

create or replace function public.fn_guard_clickup_run_assets_completion()
returns trigger language plpgsql set search_path = public, pg_temp as $$
begin
  if new.status in ('completed','completed_with_errors') then
    if exists (select 1 from public.clickup_asset_items i where i.organization_id=new.organization_id
      and i.run_id=new.id and i.status in ('ready','processing','retry_wait')) then
      new.status:='running'; new.finished_at:=null; new.lease_owner:=old.lease_owner;
      new.lease_token:=old.lease_token; new.lease_expires_at:=old.lease_expires_at; new.heartbeat_at:=old.heartbeat_at;
    elsif exists (select 1 from public.clickup_asset_items i where i.organization_id=new.organization_id
      and i.run_id=new.id and i.status in ('failed','conflict')) then new.status:='completed_with_errors'; end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clickup_lead_attachment_quota on public.crm_lead_attachments;
create trigger trg_clickup_lead_attachment_quota before insert on public.crm_lead_attachments for each row execute function public.fn_guard_clickup_attachment_quota();
drop trigger if exists trg_clickup_task_attachment_quota on public.crm_task_attachments;
create trigger trg_clickup_task_attachment_quota before insert on public.crm_task_attachments for each row execute function public.fn_guard_clickup_attachment_quota();
drop trigger if exists trg_clickup_knowledge_attachment_quota on public.ai_knowledge_source_attachments;
create trigger trg_clickup_knowledge_attachment_quota before insert on public.ai_knowledge_source_attachments for each row execute function public.fn_guard_clickup_attachment_quota();
drop trigger if exists trg_clickup_lead_attachment_delete on public.crm_lead_attachments;
create trigger trg_clickup_lead_attachment_delete after delete on public.crm_lead_attachments for each row execute function public.fn_queue_clickup_asset_delete();
drop trigger if exists trg_clickup_task_attachment_delete on public.crm_task_attachments;
create trigger trg_clickup_task_attachment_delete after delete on public.crm_task_attachments for each row execute function public.fn_queue_clickup_asset_delete();
drop trigger if exists trg_clickup_knowledge_attachment_delete on public.ai_knowledge_source_attachments;
create trigger trg_clickup_knowledge_attachment_delete after delete on public.ai_knowledge_source_attachments for each row execute function public.fn_queue_clickup_asset_delete();
drop trigger if exists trg_clickup_run_assets_completion on public.clickup_import_runs;
create trigger trg_clickup_run_assets_completion before update of status on public.clickup_import_runs for each row execute function public.fn_guard_clickup_run_assets_completion();

alter table public.crm_task_attachments enable row level security;
alter table public.ai_knowledge_source_attachments enable row level security;
alter table public.crm_task_comments enable row level security;
alter table public.clickup_comment_receipts enable row level security;
alter table public.clickup_asset_sidecars enable row level security;
alter table public.clickup_asset_uploads enable row level security;
alter table public.clickup_asset_items enable row level security;
alter table public.clickup_asset_receipts enable row level security;

drop policy if exists crm_task_attachments_select on public.crm_task_attachments;
create policy crm_task_attachments_select on public.crm_task_attachments for select to authenticated using (
  organization_id in (select public.fn_user_org_ids())
  and exists (select 1 from public.crm_tasks t
    where t.organization_id = crm_task_attachments.organization_id
      and t.id = crm_task_attachments.task_id)
);
drop policy if exists ai_knowledge_source_attachments_select on public.ai_knowledge_source_attachments;
create policy ai_knowledge_source_attachments_select on public.ai_knowledge_source_attachments
  for select to authenticated using (
    organization_id in (select public.fn_user_org_ids())
    and exists (select 1 from public.ai_knowledge_sources s
      where s.organization_id = ai_knowledge_source_attachments.organization_id
        and s.id = ai_knowledge_source_attachments.knowledge_source_id)
  );
drop policy if exists crm_task_comments_select on public.crm_task_comments;
create policy crm_task_comments_select on public.crm_task_comments for select to authenticated using (
  organization_id in (select public.fn_user_org_ids())
  and exists (select 1 from public.crm_tasks t
    where t.organization_id = crm_task_comments.organization_id and t.id = crm_task_comments.task_id)
);
drop policy if exists clickup_comment_receipts_service_only on public.clickup_comment_receipts;
create policy clickup_comment_receipts_service_only on public.clickup_comment_receipts using (false);

-- Staging, quarantine e receipts não têm leitura/escrita direta pelo browser.
drop policy if exists clickup_asset_sidecars_service_only on public.clickup_asset_sidecars;
create policy clickup_asset_sidecars_service_only on public.clickup_asset_sidecars using (false);
drop policy if exists clickup_asset_uploads_service_only on public.clickup_asset_uploads;
create policy clickup_asset_uploads_service_only on public.clickup_asset_uploads using (false);
drop policy if exists clickup_asset_items_service_only on public.clickup_asset_items;
create policy clickup_asset_items_service_only on public.clickup_asset_items using (false);
drop policy if exists clickup_asset_receipts_service_only on public.clickup_asset_receipts;
create policy clickup_asset_receipts_service_only on public.clickup_asset_receipts using (false);

revoke all on table public.crm_task_attachments from public, anon, authenticated, service_role;
revoke all on table public.ai_knowledge_source_attachments from public, anon, authenticated, service_role;
revoke all on table public.crm_task_comments from public, anon, authenticated, service_role;
revoke all on table public.clickup_comment_receipts from public, anon, authenticated, service_role;
revoke all on table public.clickup_asset_sidecars from public, anon, authenticated, service_role;
revoke all on table public.clickup_asset_uploads from public, anon, authenticated, service_role;
revoke all on table public.clickup_asset_items from public, anon, authenticated, service_role;
revoke all on table public.clickup_asset_receipts from public, anon, authenticated, service_role;
grant select on table public.crm_task_attachments to authenticated;
grant select on table public.ai_knowledge_source_attachments to authenticated;
grant select on table public.crm_task_comments to authenticated;
grant select, insert, update, delete on table public.crm_task_attachments to service_role;
grant select, insert, update, delete on table public.ai_knowledge_source_attachments to service_role;
grant select, insert, update, delete on table public.crm_task_comments to service_role;
grant select, insert, update, delete on table public.clickup_comment_receipts to service_role;
grant select, insert, update, delete on table public.clickup_asset_sidecars to service_role;
grant select, insert, update, delete on table public.clickup_asset_uploads to service_role;
grant select, insert, update, delete on table public.clickup_asset_items to service_role;
grant select, insert, update, delete on table public.clickup_asset_receipts to service_role;

revoke execute on function public.fn_claim_clickup_asset(uuid,integer)
  from public, anon, authenticated;
revoke execute on function public.fn_stage_clickup_asset_sidecar(uuid,uuid,uuid,jsonb)
  from public, anon, authenticated;
revoke execute on function public.fn_apply_clickup_lead_comment(uuid,text,text,uuid,text,timestamptz,timestamptz,text,text,text,text)
  from public, anon, authenticated;
revoke execute on function public.fn_apply_clickup_task_comment(uuid,text,text,uuid,text,text,text,text,text,timestamptz,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.fn_heartbeat_clickup_asset(uuid,uuid,uuid,integer)
  from public, anon, authenticated;
revoke execute on function public.fn_finish_clickup_asset(uuid,uuid,uuid,text,timestamptz,text,text,text)
  from public, anon, authenticated;
revoke execute on function public.fn_expurgar_clickup_asset_staging(integer)
  from public, anon, authenticated;
revoke execute on function public.fn_commit_clickup_asset(uuid,uuid,uuid,text,uuid,uuid,text,bigint,text)
  from public, anon, authenticated;
revoke execute on function public.fn_queue_clickup_asset_orphan(uuid,text)
  from public, anon, authenticated;
revoke execute on function public.fn_queue_clickup_quarantine_cleanup(uuid,uuid)
  from public, anon, authenticated;
revoke execute on function public.fn_reconcile_clickup_asset_orphans(integer)
  from public, anon, authenticated;
grant execute on function public.fn_claim_clickup_asset(uuid,integer) to service_role;
grant execute on function public.fn_stage_clickup_asset_sidecar(uuid,uuid,uuid,jsonb)
  to service_role;
grant execute on function public.fn_apply_clickup_lead_comment(uuid,text,text,uuid,text,timestamptz,timestamptz,text,text,text,text)
  to service_role;
grant execute on function public.fn_apply_clickup_task_comment(uuid,text,text,uuid,text,text,text,text,text,timestamptz,timestamptz)
  to service_role;
grant execute on function public.fn_heartbeat_clickup_asset(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.fn_finish_clickup_asset(uuid,uuid,uuid,text,timestamptz,text,text,text)
  to service_role;
grant execute on function public.fn_expurgar_clickup_asset_staging(integer) to service_role;
grant execute on function public.fn_commit_clickup_asset(uuid,uuid,uuid,text,uuid,uuid,text,bigint,text)
  to service_role;
grant execute on function public.fn_queue_clickup_asset_orphan(uuid,text) to service_role;
grant execute on function public.fn_queue_clickup_quarantine_cleanup(uuid,uuid) to service_role;
grant execute on function public.fn_reconcile_clickup_asset_orphans(integer) to service_role;

drop trigger if exists trg_crm_task_attachments_updated_at on public.crm_task_attachments;
drop trigger if exists trg_ai_knowledge_source_attachments_updated_at on public.ai_knowledge_source_attachments;
drop trigger if exists trg_clickup_asset_sidecars_updated_at on public.clickup_asset_sidecars;
create trigger trg_clickup_asset_sidecars_updated_at before update on public.clickup_asset_sidecars
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_clickup_asset_uploads_updated_at on public.clickup_asset_uploads;
create trigger trg_clickup_asset_uploads_updated_at before update on public.clickup_asset_uploads
  for each row execute function public.fn_set_updated_at();
drop trigger if exists trg_clickup_asset_items_updated_at on public.clickup_asset_items;
create trigger trg_clickup_asset_items_updated_at before update on public.clickup_asset_items
  for each row execute function public.fn_set_updated_at();

comment on table public.ai_knowledge_source_attachments is
  'Arquivos ClickUp disponíveis para download. indexed_at permanece NULL: esta onda não promete indexação RAG.';
comment on table public.clickup_asset_uploads is
  'Recibos de upload privado ligados a org, usuário, run, snapshot e hash. O cliente nunca escolhe storage_path.';

notify pgrst, 'reload schema';
