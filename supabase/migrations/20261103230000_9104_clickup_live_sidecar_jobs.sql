-- manifest: Coleta durável e retomável de comentários, replies e assets ClickUp usando a conexão cifrada do CRM.

create table if not exists public.clickup_sidecar_collection_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  workspace_id text not null,
  connection_id uuid not null,
  mode text not null check (mode in ('inventory','full')),
  include_private_docs boolean not null default true,
  status text not null default 'queued' check (
    status in ('queued','running','finalizing','completed','completed_with_errors','failed','cancelled')
  ),
  tasks_expected integer not null default 0 check (tasks_expected >= 0),
  parents_completed integer not null default 0 check (parents_completed >= 0),
  lease_owner uuid,
  lease_token uuid,
  lease_expires_at timestamptz,
  checkpoint jsonb not null default '{}'::jsonb check (jsonb_typeof(checkpoint) = 'object'),
  error_code text,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint clickup_sidecar_collection_jobs_run_fkey
    foreign key (organization_id,run_id,workspace_id)
    references public.clickup_import_runs(organization_id,id,workspace_id) on delete cascade,
  constraint clickup_sidecar_collection_jobs_connection_fkey
    foreign key (organization_id,connection_id,workspace_id)
    references public.clickup_connections(organization_id,id,workspace_id) on delete restrict,
  constraint clickup_sidecar_collection_jobs_lease_shape check (
    (status='running' and lease_owner is not null and lease_token is not null and lease_expires_at is not null)
    or (status<>'running' and lease_owner is null and lease_token is null and lease_expires_at is null)
  ),
  unique (organization_id,run_id),
  unique (organization_id,id,run_id)
);

create table if not exists public.clickup_sidecar_collection_parents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null,
  run_id uuid not null,
  parent_type text not null check (parent_type in ('task','doc_page','docs_inventory')),
  external_id text not null check (length(btrim(external_id)) between 1 and 512),
  source_container_id text,
  status text not null default 'queued' check (
    status in ('queued','processing','retry_wait','completed','failed','cancelled')
  ),
  attempts integer not null default 0 check (attempts between 0 and 20),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20),
  next_attempt_at timestamptz,
  claim_token uuid,
  claimed_until timestamptz,
  result jsonb check (result is null or jsonb_typeof(result)='object'),
  error_code text,
  error_message text check (error_message is null or length(error_message)<=500),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint clickup_sidecar_collection_parents_job_fkey
    foreign key (organization_id,job_id,run_id)
    references public.clickup_sidecar_collection_jobs(organization_id,id,run_id) on delete cascade,
  constraint clickup_sidecar_collection_parents_claim_shape check (
    (status='processing' and claim_token is not null and claimed_until is not null)
    or (status<>'processing' and claim_token is null and claimed_until is null)
  ),
  constraint clickup_sidecar_collection_parents_retry_shape check (
    (status='retry_wait' and next_attempt_at is not null)
    or (status<>'retry_wait' and next_attempt_at is null)
  ),
  constraint clickup_sidecar_collection_parents_result_shape check (
    (status='completed' and result is not null) or (status<>'completed' and result is null)
  ),
  unique (organization_id,job_id,parent_type,external_id)
);

create index if not exists clickup_sidecar_collection_parents_claim_idx
  on public.clickup_sidecar_collection_parents(status,next_attempt_at,created_at,id)
  where status in ('queued','processing','retry_wait');

alter table public.clickup_sidecar_collection_jobs enable row level security;
alter table public.clickup_sidecar_collection_jobs force row level security;
alter table public.clickup_sidecar_collection_parents enable row level security;
alter table public.clickup_sidecar_collection_parents force row level security;
drop policy if exists clickup_sidecar_collection_jobs_service_only on public.clickup_sidecar_collection_jobs;
create policy clickup_sidecar_collection_jobs_service_only on public.clickup_sidecar_collection_jobs using (false);
drop policy if exists clickup_sidecar_collection_parents_service_only on public.clickup_sidecar_collection_parents;
create policy clickup_sidecar_collection_parents_service_only on public.clickup_sidecar_collection_parents using (false);
revoke all on table public.clickup_sidecar_collection_jobs from public,anon,authenticated,service_role;
revoke all on table public.clickup_sidecar_collection_parents from public,anon,authenticated,service_role;
grant select,insert,update,delete on table public.clickup_sidecar_collection_jobs to service_role;
grant select,insert,update,delete on table public.clickup_sidecar_collection_parents to service_role;

create or replace function public.fn_start_clickup_live_sidecar(
  p_organization_id uuid,p_run_id uuid,p_mode text,p_include_private_docs boolean,p_created_by uuid
) returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r public.clickup_import_runs%rowtype;
declare j public.clickup_sidecar_collection_jobs%rowtype;
begin
  select * into r from public.clickup_import_runs where organization_id=p_organization_id and id=p_run_id
    and status in ('preview','ready') and cancel_requested_at is null for update;
  if not found or p_mode not in ('inventory','full') or p_include_private_docs is distinct from true or not exists (
    select 1 from public.organizations where id=p_organization_id and status='active'
  ) then raise exception 'clickup_live_sidecar_run_not_available' using errcode='P0002'; end if;
  select * into j from public.clickup_sidecar_collection_jobs
    where organization_id=p_organization_id and run_id=p_run_id for update;
  if found then
    if j.mode<>p_mode or j.include_private_docs<>p_include_private_docs then
      raise exception 'clickup_live_sidecar_mode_conflict' using errcode='P0001';
    end if;
    if j.status='completed_with_errors' then
      update public.clickup_sidecar_collection_parents set status='queued',attempts=0,
        next_attempt_at=null,claim_token=null,claimed_until=null,error_code=null,error_message=null,
        updated_at=clock_timestamp()
        where job_id=j.id and status='failed';
      update public.clickup_sidecar_collection_jobs set status='queued',error_code=null,
        lease_owner=null,lease_token=null,lease_expires_at=null,finished_at=null,
        updated_at=clock_timestamp() where id=j.id;
    end if;
    return j.id;
  end if;
  insert into public.clickup_sidecar_collection_jobs(
    organization_id,run_id,workspace_id,connection_id,mode,include_private_docs,checkpoint,created_by
  ) values (p_organization_id,p_run_id,r.workspace_id,r.connection_id,p_mode,p_include_private_docs,
    jsonb_build_object('snapshot_hash',r.snapshot_hash),p_created_by)
  returning * into j;
  insert into public.clickup_sidecar_collection_parents(
    organization_id,job_id,run_id,parent_type,external_id
  ) select p_organization_id,j.id,p_run_id,'task',i.external_id
      from public.clickup_import_items i where i.organization_id=p_organization_id
       and i.run_id=p_run_id and i.entity_type='task'
    on conflict do nothing;
  insert into public.clickup_sidecar_collection_parents(
    organization_id,job_id,run_id,parent_type,external_id
  ) values (p_organization_id,j.id,p_run_id,'docs_inventory',r.workspace_id)
    on conflict do nothing;
  insert into public.clickup_sidecar_collection_parents(
    organization_id,job_id,run_id,parent_type,external_id,source_container_id
  ) select p_organization_id,j.id,p_run_id,'doc_page',page_id.value,i.external_id
      from public.clickup_import_items i
      cross join lateral jsonb_array_elements_text(
        case when jsonb_typeof(i.source_metadata->'page_ids')='array'
          then i.source_metadata->'page_ids' else '[]'::jsonb end
      ) page_id(value)
      where i.organization_id=p_organization_id and i.run_id=p_run_id and i.entity_type='doc'
    on conflict do nothing;
  update public.clickup_sidecar_collection_jobs set tasks_expected=(
    select count(*) from public.clickup_sidecar_collection_parents where job_id=j.id and parent_type='task'
  ) where id=j.id;
  update public.clickup_sidecar_collection_jobs set status='finalizing'
    where id=j.id and not exists(
      select 1 from public.clickup_sidecar_collection_parents where job_id=j.id
    );
  return j.id;
end $$;

create or replace function public.fn_seed_clickup_live_doc_pages(
  p_organization_id uuid,p_parent_id uuid,p_claim_token uuid,p_pages jsonb
) returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.clickup_sidecar_collection_parents%rowtype;
declare inserted_count integer;
begin
  if jsonb_typeof(p_pages)<>'array' or jsonb_array_length(p_pages)>10000 then
    raise exception 'invalid_clickup_live_doc_pages' using errcode='22023'; end if;
  select * into p from public.clickup_sidecar_collection_parents where organization_id=p_organization_id
    and id=p_parent_id and parent_type='docs_inventory' and status='processing'
    and claim_token=p_claim_token and claimed_until>=clock_timestamp() for update;
  if not found then raise exception 'clickup_live_docs_inventory_lease_lost' using errcode='P0002'; end if;
  with inserted as (
    insert into public.clickup_sidecar_collection_parents(
      organization_id,job_id,run_id,parent_type,external_id,source_container_id
    ) select p.organization_id,p.job_id,p.run_id,'doc_page',x.page_id,x.doc_id
      from jsonb_to_recordset(p_pages) x(doc_id text,page_id text)
      where length(btrim(x.doc_id)) between 1 and 512 and length(btrim(x.page_id)) between 1 and 512
    on conflict do nothing returning 1
  ) select count(*) into inserted_count from inserted;
  return inserted_count;
end $$;

create or replace function public.fn_claim_clickup_live_sidecar_parent(
  p_worker_id uuid,p_lease_seconds integer default 120
) returns table(job jsonb,parent jsonb) language plpgsql security definer set search_path=public,pg_temp as $$
declare v_parent public.clickup_sidecar_collection_parents%rowtype;
declare v_job public.clickup_sidecar_collection_jobs%rowtype;
begin
  if p_worker_id is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid_clickup_live_sidecar_lease' using errcode='22023'; end if;
  update public.clickup_sidecar_collection_parents p set status='cancelled',claim_token=null,
    claimed_until=null,next_attempt_at=null,error_code='run_cancelled',updated_at=clock_timestamp()
    where p.status in ('queued','processing','retry_wait') and exists(
      select 1 from public.clickup_import_runs r where r.organization_id=p.organization_id
        and r.id=p.run_id and r.cancel_requested_at is not null
    );
  update public.clickup_sidecar_collection_jobs j set status='cancelled',lease_owner=null,
    lease_token=null,lease_expires_at=null,finished_at=clock_timestamp(),updated_at=clock_timestamp()
    where j.status in ('queued','running','finalizing')
      and exists(select 1 from public.clickup_import_runs r where r.id=j.run_id
        and r.organization_id=j.organization_id and r.cancel_requested_at is not null);
  update public.clickup_sidecar_collection_parents set status=case when attempts<max_attempts then 'retry_wait' else 'failed' end,
    next_attempt_at=case when attempts<max_attempts then clock_timestamp() else null end,
    claim_token=null,claimed_until=null,error_code='lease_expired',updated_at=clock_timestamp()
    where status='processing' and claimed_until<clock_timestamp();
  update public.clickup_sidecar_collection_jobs j set
    parents_completed=(select count(*) from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status='completed'),
    status=case
      when exists(select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status in ('queued','processing','retry_wait')) then 'queued'
      when exists(select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status='failed') then 'completed_with_errors'
      else 'finalizing' end,
    error_code=case when exists(
      select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status='failed'
    ) then (select x.error_code from public.clickup_sidecar_collection_parents x
      where x.job_id=j.id and x.status='failed' order by x.updated_at desc limit 1) else null end,
    lease_owner=null,lease_token=null,lease_expires_at=null,
    finished_at=case
      when not exists(select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status in ('queued','processing','retry_wait'))
       and exists(select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status='failed')
      then clock_timestamp() else null end,
    updated_at=clock_timestamp()
    where j.status in ('queued','running') and not exists(
      select 1 from public.clickup_sidecar_collection_parents x
      where x.job_id=j.id and x.status='processing' and x.claimed_until>=clock_timestamp()
    );
  select p0.* into v_parent from public.clickup_sidecar_collection_parents p0
    join public.clickup_sidecar_collection_jobs j0 on j0.organization_id=p0.organization_id and j0.id=p0.job_id
    join public.clickup_import_runs r on r.organization_id=p0.organization_id and r.id=p0.run_id
    join public.organizations o on o.id=p0.organization_id and o.status='active'
    where p0.status in ('queued','retry_wait') and coalesce(p0.next_attempt_at,'-infinity')<=clock_timestamp()
      and j0.status in ('queued','running') and r.status in ('preview','ready') and r.cancel_requested_at is null
    order by p0.created_at,p0.id for update of p0 skip locked limit 1;
  if not found then return; end if;
  update public.clickup_sidecar_collection_parents set status='processing',attempts=attempts+1,
    claim_token=gen_random_uuid(),claimed_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    next_attempt_at=null,updated_at=clock_timestamp() where id=v_parent.id returning * into v_parent;
  update public.clickup_sidecar_collection_jobs set status='running',lease_owner=p_worker_id,
    lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
    updated_at=clock_timestamp() where id=v_parent.job_id returning * into v_job;
  return query select to_jsonb(v_job)-'lease_token',to_jsonb(v_parent);
end $$;

create or replace function public.fn_heartbeat_clickup_live_sidecar_parent(
  p_organization_id uuid,p_parent_id uuid,p_claim_token uuid,p_lease_seconds integer default 300
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare renewed uuid;
begin
  if p_lease_seconds not between 30 and 900 then
    raise exception 'invalid_clickup_live_sidecar_lease' using errcode='22023'; end if;
  update public.clickup_sidecar_collection_parents p set
    claimed_until=clock_timestamp()+make_interval(secs=>p_lease_seconds),updated_at=clock_timestamp()
    where p.organization_id=p_organization_id and p.id=p_parent_id and p.status='processing'
      and p.claim_token=p_claim_token and p.claimed_until>=clock_timestamp()
      and exists(select 1 from public.clickup_import_runs r where r.organization_id=p.organization_id
        and r.id=p.run_id and r.cancel_requested_at is null and r.status in ('preview','ready'))
    returning id into renewed;
  return renewed is not null;
end $$;

create or replace function public.fn_finish_clickup_live_sidecar_parent(
  p_organization_id uuid,p_parent_id uuid,p_claim_token uuid,p_outcome text,
  p_result jsonb default null,p_retry_at timestamptz default null,p_error_code text default null,
  p_error_message text default null
) returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare p public.clickup_sidecar_collection_parents%rowtype;
begin
  if p_outcome not in ('completed','retry_wait','failed','cancelled') then
    raise exception 'invalid_clickup_live_sidecar_outcome' using errcode='22023'; end if;
  update public.clickup_sidecar_collection_parents set status=p_outcome,
    result=case when p_outcome='completed' then p_result else null end,
    next_attempt_at=case when p_outcome='retry_wait' then p_retry_at else null end,
    claim_token=null,claimed_until=null,error_code=p_error_code,error_message=left(p_error_message,500),
    updated_at=clock_timestamp()
    where organization_id=p_organization_id and id=p_parent_id and status='processing'
      and claim_token=p_claim_token and claimed_until>=clock_timestamp() returning * into p;
  if not found then return false; end if;
  update public.clickup_sidecar_collection_jobs j set
    parents_completed=(select count(*) from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status='completed'),
    status=case
      when exists(select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status in ('queued','processing','retry_wait')) then 'queued'
      when exists(select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status='failed') then 'completed_with_errors'
      else 'finalizing' end,
    error_code=case when exists(
      select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status='failed'
    ) then (select x.error_code from public.clickup_sidecar_collection_parents x
      where x.job_id=j.id and x.status='failed' order by x.updated_at desc limit 1) else null end,
    lease_owner=null,lease_token=null,lease_expires_at=null,
    finished_at=case
      when not exists(select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status in ('queued','processing','retry_wait'))
       and exists(select 1 from public.clickup_sidecar_collection_parents x where x.job_id=j.id and x.status='failed')
      then clock_timestamp() else null end,
    updated_at=clock_timestamp()
    where j.id=p.job_id;
  return true;
end $$;

revoke execute on function public.fn_start_clickup_live_sidecar(uuid,uuid,text,boolean,uuid) from public,anon,authenticated;
revoke execute on function public.fn_seed_clickup_live_doc_pages(uuid,uuid,uuid,jsonb) from public,anon,authenticated;
revoke execute on function public.fn_claim_clickup_live_sidecar_parent(uuid,integer) from public,anon,authenticated;
revoke execute on function public.fn_heartbeat_clickup_live_sidecar_parent(uuid,uuid,uuid,integer) from public,anon,authenticated;
revoke execute on function public.fn_finish_clickup_live_sidecar_parent(uuid,uuid,uuid,text,jsonb,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.fn_start_clickup_live_sidecar(uuid,uuid,text,boolean,uuid) to service_role;
grant execute on function public.fn_seed_clickup_live_doc_pages(uuid,uuid,uuid,jsonb) to service_role;
grant execute on function public.fn_claim_clickup_live_sidecar_parent(uuid,integer) to service_role;
grant execute on function public.fn_heartbeat_clickup_live_sidecar_parent(uuid,uuid,uuid,integer) to service_role;
grant execute on function public.fn_finish_clickup_live_sidecar_parent(uuid,uuid,uuid,text,jsonb,timestamptz,text,text) to service_role;
