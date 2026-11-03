import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_LEAD,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  lastLine,
  seedGov,
  sql,
} from "./gov-helpers";

const TASK_A = "90980000-1000-4000-8000-000000000001";
const TASK_B = "90980000-1000-4000-8000-000000000002";
const RELATION = "90980000-1000-4000-8000-000000000003";
const CONNECTION = "90980000-1000-4000-8000-000000000004";
const RUN = "90980000-1000-4000-8000-000000000005";
const WORKER = "90980000-1000-4000-8000-000000000006";
const LEASE = "90980000-1000-4000-8000-000000000007";
const ITEM_A = "90980000-1000-4000-8000-000000000008";
const ITEM_B = "90980000-1000-4000-8000-000000000009";
const ITEM_REL = "90980000-1000-4000-8000-000000000010";
const OTHER_ORG = "90980000-2000-4000-8000-000000000001";
const OTHER_TASK_A = "90980000-2000-4000-8000-000000000002";
const OTHER_TASK_B = "90980000-2000-4000-8000-000000000003";
const OTHER_RELATION = "90980000-2000-4000-8000-000000000004";

describe("W3.3.3 — fidelidade e relações ClickUp", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into public.crm_tasks
        (id, organization_id, title, priority, tags, start_at, time_estimate_ms, source_metadata)
      values ('${TASK_B}', '${GOV_ORG}', 'B', 'medium', array['VIP'], '2024-03-10T06:30:00Z', 0,
          '{"clickup":{"archive_scope":"active_and_archived"}}')
      on conflict (id) do nothing;
      insert into public.crm_clickup_relations
        (id, organization_id, workspace_id, relation_type, source_external_id,
         target_external_id, left_lead_id, right_task_id, source_hash)
      values ('${RELATION}', '${GOV_ORG}', 'wk-fidelity', 'linked', 'external-a', 'external-b',
        '${GOV_LEAD}', '${TASK_B}', '${"a".repeat(64)}')
      on conflict do nothing;
      insert into public.organizations(id,slug,legal_name,display_name)
      values ('${OTHER_ORG}','w3-fidelity-other','W3 Fidelity Other','W3 Other')
      on conflict do nothing;
      insert into public.crm_tasks(id,organization_id,title) values
        ('${OTHER_TASK_A}','${OTHER_ORG}','Other A'),
        ('${OTHER_TASK_B}','${OTHER_ORG}','Other B') on conflict (id) do nothing;
      insert into public.crm_clickup_relations
        (id,organization_id,workspace_id,relation_type,source_external_id,target_external_id,
         left_task_id,right_task_id,source_hash)
      values ('${OTHER_RELATION}','${OTHER_ORG}','wk-other','linked','other-a','other-b',
        '${OTHER_TASK_A}','${OTHER_TASK_B}','${"9".repeat(64)}') on conflict do nothing;
    `);
  });

  it("materializa campos com estimativa zero, GIN e CHECK de prioridade vivo", () => {
    expect(
      sql(`select tags::text || ':' || time_estimate_ms::text || ':' ||
        (source_metadata->'clickup'->>'archive_scope')
        from public.crm_tasks where id = '${TASK_B}';`),
    ).toBe("{VIP}:0:active_and_archived");
    expect(
      sql(`select indexdef ilike '%using gin (tags)%' from pg_indexes
        where schemaname='public' and indexname='crm_tasks_tags_gin_idx';`),
    ).toBe("t");
    // `normal` pertence ao ClickUp, não ao vocabulário operacional do CRM.
    expect(
      lastLine(
        sql(`do $test$ begin
      begin
        insert into public.crm_tasks(id,organization_id,title,priority)
        values ('${TASK_A}','${GOV_ORG}','inválida','normal');
        raise exception 'priority_accepted';
      exception when check_violation then null; end;
    end $test$; select 'ok';`),
      ),
    ).toBe("ok");
  });

  it("isola relações por tenant e recusa endpoint dangling/cross-org", () => {
    expect(countAs(GOV_VIEWER, `select count(*) from public.crm_clickup_relations;`)).toBe(1);
    expect(sql(`select count(*) from public.crm_clickup_relations;`)).toBe("2");
    expect(
      lastLine(
        sql(`do $test$ begin
        begin
          insert into public.crm_clickup_relations
            (organization_id,workspace_id,relation_type,source_external_id,target_external_id,
             left_task_id,right_task_id,source_hash)
          values ('${GOV_ORG}','wk','linked','x','y',gen_random_uuid(),'${TASK_B}','${"b".repeat(64)}');
          raise exception 'dangling_accepted';
        exception when foreign_key_violation then null; end;
      end $test$; select 'ok';`),
      ),
    ).toBe("ok");
    expect(
      sql(`select count(*) from information_schema.role_table_grants
        where table_schema='public' and table_name='crm_clickup_relations'
          and grantee='authenticated' and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE');`),
    ).toBe("0");
  });

  it("não consome tentativa da relação antes de ambos os pais terminarem", () => {
    sql(`
      insert into public.clickup_connections
        (id,organization_id,workspace_id,workspace_name,token_ciphertext,token_iv,token_tag,token_last4,created_by)
      values ('${CONNECTION}','${GOV_ORG}','wk-gate','Gate','\\x01',decode(repeat('01',12),'hex'),
        decode(repeat('02',16),'hex'),'1234','${GOV_ADMIN}') on conflict do nothing;
      insert into public.clickup_import_runs
        (id,organization_id,connection_id,workspace_id,source,scope,status,snapshot_hash,
         lease_owner,lease_token,lease_expires_at,heartbeat_at,started_at)
      values ('${RUN}','${GOV_ORG}','${CONNECTION}','wk-gate','bundle','crm','running',
        '${"c".repeat(64)}','${WORKER}','${LEASE}',now()+interval '5 minutes',now(),now())
      on conflict do nothing;
      insert into public.clickup_import_processor_leases
        (run_id,processor,worker_id,lease_token,lease_expires_at,heartbeat_at)
      values ('${RUN}','crm','${WORKER}','${LEASE}',now()+interval '5 minutes',now())
      on conflict (run_id,processor) do update set lease_expires_at=excluded.lease_expires_at;
      insert into public.clickup_import_items
        (id,organization_id,run_id,workspace_id,entity_type,external_id,source_hash,status,source_metadata)
      values
        ('${ITEM_A}','${GOV_ORG}','${RUN}','wk-gate','task','a','${"d".repeat(64)}','ready','{}'),
        ('${ITEM_B}','${GOV_ORG}','${RUN}','wk-gate','task','b','${"e".repeat(64)}','ready','{}'),
        ('${ITEM_REL}','${GOV_ORG}','${RUN}','wk-gate','task_relation','linked:a:b',
          '${"f".repeat(64)}','ready','{"source_task_id":"a","target_task_id":"b","relation_type":"linked"}')
      on conflict (id) do update set status=excluded.status,attempts=0,claim_token=null,claimed_until=null;
    `);
    expect(
      sql(`select coalesce((public.fn_claim_clickup_import_item_for_scope(
        '${GOV_ORG}','${RUN}','crm',90)).entity_type,'');`),
    ).toBe("task");
    expect(sql(`select attempts from public.clickup_import_items where id='${ITEM_REL}';`)).toBe(
      "0",
    );
    sql(`select set_config('deskcomm.clickup_transition','claim',false);
      update public.clickup_import_items set status='processing',attempts=attempts+1,
        claim_token=coalesce(claim_token,gen_random_uuid()),claimed_until=now()+interval '5 minutes'
      where id='${ITEM_B}';
      select set_config('deskcomm.clickup_transition','finish',false);
      update public.clickup_import_items set status='succeeded',claim_token=null,claimed_until=null
      where id in ('${ITEM_A}','${ITEM_B}');`);
    expect(
      sql(`select (public.fn_claim_clickup_import_item_for_scope(
        '${GOV_ORG}','${RUN}','crm',90)).id::text;`),
    ).toBe(ITEM_REL);
  });

  it("stage aceita os 5.813 objetos do snapshot completo sem elevar o teto de bytes HTTP", () => {
    const stagedRun = sql(`
      with items as (
        select jsonb_agg(jsonb_build_object(
          'entity_type','task',
          'external_id','volume-' || n::text,
          'source_hash',repeat('a',64),
          'source_metadata','{}'::jsonb,
          'content_access','none',
          'execution_blocked',false,
          'status','ready'
        )) payload
        from generate_series(1,5813) n
      )
      select public.fn_stage_clickup_import_preview(
        '${GOV_ORG}','${CONNECTION}','wk-gate','bundle','crm',3,repeat('b',64),null,
        '${GOV_ADMIN}',payload
      )::text from items;
    `);
    expect(sql(`select count(*) from public.clickup_import_items where run_id='${stagedRun}';`)).toBe(
      "5813",
    );
    expect(
      sql(`select pg_get_functiondef('public.fn_stage_clickup_import_preview(uuid,uuid,text,text,text,integer,text,text,uuid,jsonb)'::regprocedure)
        like '%jsonb_array_length(p_items) > 10000%';`),
    ).toBe("t");
    sql(`delete from public.clickup_import_runs where id='${stagedRun}';`);
  });
});
