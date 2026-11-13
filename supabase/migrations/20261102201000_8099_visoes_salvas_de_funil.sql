-- manifest: Salva visualizações pessoais ou compartilhadas de cada funil com filtros e configuração validados pela aplicação, preservando isolamento por organização e autorização por dono.

create unique index if not exists crm_pipelines_org_id_uidx
  on public.crm_pipelines (organization_id, id);

create table if not exists public.crm_pipeline_views (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  pipeline_id uuid not null,
  owner_user_id uuid references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  name text not null,
  visibility text not null default 'personal',
  view_type text not null default 'quadro',
  filters jsonb not null default '{}'::jsonb,
  sort_config jsonb not null default '{}'::jsonb,
  view_config jsonb not null default '{}'::jsonb,
  schema_version integer not null default 1,
  position numeric not null default 1000,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_pipeline_views_org_id_key unique (organization_id, id),
  constraint crm_pipeline_views_pipeline_fkey foreign key (organization_id, pipeline_id)
    references public.crm_pipelines (organization_id, id) on delete cascade,
  constraint crm_pipeline_views_name_check check (char_length(btrim(name)) between 1 and 80),
  constraint crm_pipeline_views_visibility_check check (visibility in ('personal', 'shared')),
  constraint crm_pipeline_views_type_check check (view_type in ('quadro', 'lista', 'calendario')),
  constraint crm_pipeline_views_owner_shape check (
    (visibility = 'personal' and owner_user_id is not null)
    or (visibility = 'shared' and owner_user_id is null)
  ),
  constraint crm_pipeline_views_json_check check (
    jsonb_typeof(filters) = 'object'
    and jsonb_typeof(sort_config) = 'object'
    and jsonb_typeof(view_config) = 'object'
  ),
  constraint crm_pipeline_views_schema_version_check check (schema_version = 1)
);

create unique index if not exists crm_pipeline_views_personal_name_uidx
  on public.crm_pipeline_views (organization_id, pipeline_id, owner_user_id, lower(btrim(name)))
  where visibility = 'personal';
create unique index if not exists crm_pipeline_views_shared_name_uidx
  on public.crm_pipeline_views (organization_id, pipeline_id, lower(btrim(name)))
  where visibility = 'shared';
create index if not exists crm_pipeline_views_org_pipeline_position_idx
  on public.crm_pipeline_views (organization_id, pipeline_id, position, id);

create index if not exists idx_crm_leads_org_pipeline_title_id
  on public.crm_leads (organization_id, pipeline_id, title, id);
create index if not exists idx_crm_leads_org_pipeline_last_activity_id
  on public.crm_leads (organization_id, pipeline_id, last_activity_at, id);

alter table public.crm_pipeline_views enable row level security;

drop policy if exists crm_pipeline_views_select on public.crm_pipeline_views;
create policy crm_pipeline_views_select on public.crm_pipeline_views
  for select using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (visibility = 'shared' or owner_user_id = auth.uid())
    )
  );

drop policy if exists crm_pipeline_views_insert on public.crm_pipeline_views;
create policy crm_pipeline_views_insert on public.crm_pipeline_views
  for insert with check (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and created_by = auth.uid()
      and (
        (visibility = 'personal' and owner_user_id = auth.uid())
        or (visibility = 'shared' and owner_user_id is null
          and public.fn_role_at_least(organization_id, 'manager'))
      )
    )
  );

drop policy if exists crm_pipeline_views_update on public.crm_pipeline_views;
create policy crm_pipeline_views_update on public.crm_pipeline_views
  for update using (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        (visibility = 'personal' and owner_user_id = auth.uid())
        or (visibility = 'shared' and public.fn_role_at_least(organization_id, 'manager'))
      )
    )
  ) with check (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        (visibility = 'personal' and owner_user_id = auth.uid())
        or (visibility = 'shared' and owner_user_id is null
          and public.fn_role_at_least(organization_id, 'manager'))
      )
    )
  );

drop policy if exists crm_pipeline_views_delete on public.crm_pipeline_views;
create policy crm_pipeline_views_delete on public.crm_pipeline_views
  for delete using (
    public.fn_is_platform_admin_full()
    or (
      organization_id in (select public.fn_user_org_ids())
      and (
        (visibility = 'personal' and owner_user_id = auth.uid())
        or (visibility = 'shared' and public.fn_role_at_least(organization_id, 'manager'))
      )
    )
  );

revoke all on table public.crm_pipeline_views from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.crm_pipeline_views to authenticated;
grant select, insert, update, delete on table public.crm_pipeline_views to service_role;

drop trigger if exists trg_crm_pipeline_views_updated_at on public.crm_pipeline_views;
create trigger trg_crm_pipeline_views_updated_at
  before update on public.crm_pipeline_views
  for each row execute function public.fn_set_updated_at();

comment on table public.crm_pipeline_views is
  'Visualizações salvas de um funil. JSON é contrato versionado e canonicalizado na aplicação; nunca contém SQL ou âncora temporal.';
