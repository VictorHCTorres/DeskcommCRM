-- manifest: Organiza funis em Áreas e Grupos sem mover nem apagar negócios; vínculos compostos garantem que toda relação permaneça dentro da organização.

create table if not exists public.crm_pipeline_groups (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  name text not null,
  kind text not null,
  parent_id uuid,
  parent_kind text generated always as (
    case when kind = 'grupo' then 'area'::text else null::text end
  ) stored,
  position numeric not null default 1000,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_pipeline_groups_kind_check check (kind in ('area', 'grupo')),
  constraint crm_pipeline_groups_parent_shape check (
    (kind = 'area' and parent_id is null)
    or (kind = 'grupo' and parent_id is not null)
  ),
  constraint crm_pipeline_groups_org_id_kind_key unique (organization_id, id, kind),
  constraint crm_pipeline_groups_parent_fkey foreign key (organization_id, parent_id, parent_kind)
    references public.crm_pipeline_groups (organization_id, id, kind)
    on delete restrict
);

create unique index if not exists uniq_crm_pipeline_groups_area_name
  on public.crm_pipeline_groups (organization_id, lower(name))
  where kind = 'area' and archived_at is null;

create unique index if not exists uniq_crm_pipeline_groups_group_name
  on public.crm_pipeline_groups (organization_id, parent_id, lower(name))
  where kind = 'grupo' and archived_at is null;

create index if not exists idx_crm_pipeline_groups_org_parent_position
  on public.crm_pipeline_groups (organization_id, parent_id, position)
  where archived_at is null;

alter table public.crm_pipeline_groups enable row level security;

drop policy if exists crm_pipeline_groups_select on public.crm_pipeline_groups;
create policy crm_pipeline_groups_select on public.crm_pipeline_groups
  for select using (
    organization_id in (select public.fn_user_org_ids())
    or public.fn_is_platform_admin()
  );

drop policy if exists crm_pipeline_groups_manager_write on public.crm_pipeline_groups;
drop policy if exists crm_pipeline_groups_manager_insert on public.crm_pipeline_groups;
create policy crm_pipeline_groups_manager_insert on public.crm_pipeline_groups
  for insert with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

drop policy if exists crm_pipeline_groups_manager_update on public.crm_pipeline_groups;
create policy crm_pipeline_groups_manager_update on public.crm_pipeline_groups
  for update using (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  )
  with check (
    public.fn_is_platform_admin()
    or (
      organization_id in (select public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'manager')
    )
  );

revoke all on table public.crm_pipeline_groups from public, anon, authenticated, service_role;
grant select, insert, update on table public.crm_pipeline_groups to authenticated;
grant select, insert, update on table public.crm_pipeline_groups to service_role;

drop trigger if exists trg_crm_pipeline_groups_updated_at on public.crm_pipeline_groups;
create trigger trg_crm_pipeline_groups_updated_at
  before update on public.crm_pipeline_groups
  for each row execute function public.fn_set_updated_at();

alter table public.crm_pipelines
  add column if not exists group_id uuid,
  add column if not exists group_kind text generated always as ('grupo'::text) stored;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'crm_pipelines_group_fkey'
      and conrelid = 'public.crm_pipelines'::regclass
  ) then
    alter table public.crm_pipelines
      add constraint crm_pipelines_group_fkey
      foreign key (organization_id, group_id, group_kind)
      references public.crm_pipeline_groups (organization_id, id, kind)
      on delete restrict;
  end if;
end $$;

create index if not exists idx_crm_pipelines_org_group_position
  on public.crm_pipelines (organization_id, group_id, position)
  where is_archived = false;

comment on table public.crm_pipeline_groups is
  'Hierarquia operacional Área > Grupo. Funis apontam apenas para linhas kind=grupo pela FK composta.';
comment on column public.crm_pipelines.group_id is
  'Grupo visual do funil; NULL mantém o funil em Sem grupo. Arquivar o grupo preserva o vínculo e todos os negócios.';
