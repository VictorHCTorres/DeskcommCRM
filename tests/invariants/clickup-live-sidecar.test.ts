import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, seedGov, sql } from "./gov-helpers";

const CONNECTION = "91040000-0000-4000-8000-000000000001";
const RUN = "91040000-0000-4000-8000-000000000002";
const HASH = "a".repeat(64);

describe("W3 — coleta live de sidecar ClickUp", () => {
  beforeAll(() => {
    seedGov();
    sql(`insert into public.clickup_connections
      (id,organization_id,workspace_id,workspace_name,token_ciphertext,token_iv,token_tag,token_last4,created_by)
      values ('${CONNECTION}','${GOV_ORG}','live-ws','Live','\\x0102',decode(repeat('01',12),'hex'),
        decode(repeat('02',16),'hex'),'1234','${GOV_ADMIN}');
      insert into public.clickup_import_runs
      (id,organization_id,connection_id,workspace_id,source,scope,status,manifest_version,snapshot_hash,created_by)
      values ('${RUN}','${GOV_ORG}','${CONNECTION}','live-ws','api','crm','ready',3,'${HASH}','${GOV_ADMIN}');
      insert into public.clickup_import_items
      (organization_id,run_id,workspace_id,entity_type,external_id,source_hash,source_metadata,content_access,execution_blocked,status)
      select '${GOV_ORG}','${RUN}','live-ws','task','task-'||n,'${HASH}','{}','none',false,'ready'
      from generate_series(1,2100)n;
      `);
  });

  it("recusa iniciar coleta sem inclusão explícita de Docs privados", () => {
    expect(() =>
      sql(`select public.fn_start_clickup_live_sidecar(
        '${GOV_ORG}','${RUN}','inventory',false,'${GOV_ADMIN}')::text;`),
    ).toThrow(/clickup_live_sidecar_run_not_available/);
    expect(
      sql(`select count(*) from public.clickup_sidecar_collection_jobs
        where organization_id='${GOV_ORG}' and run_id='${RUN}';`),
    ).toBe("0");
  });

  it("semeia exatamente 2.100 Tasks e inventário externo de Docs mesmo no run CRM", () => {
    const job = sql(`select public.fn_start_clickup_live_sidecar(
      '${GOV_ORG}','${RUN}','inventory',true,'${GOV_ADMIN}')::text;`);
    expect(
      sql(`select tasks_expected||':'||(select count(*) from public.clickup_sidecar_collection_parents p
      where p.job_id=j.id and p.parent_type='task')||':'||(select count(*) from public.clickup_sidecar_collection_parents p
      where p.job_id=j.id and p.parent_type='docs_inventory') from public.clickup_sidecar_collection_jobs j
      where j.id='${job}';`),
    ).toBe("2100:2100:1");
    const inventory = sql(`update public.clickup_sidecar_collection_parents set status='processing',
      attempts=1,claim_token='91040000-0000-4000-8000-000000000088',claimed_until=now()+interval '5 minutes'
      where job_id='${job}' and parent_type='docs_inventory' returning id::text;`).split("\n")[0]!;
    expect(
      sql(`select public.fn_seed_clickup_live_doc_pages('${GOV_ORG}','${inventory}',
      '91040000-0000-4000-8000-000000000088','[{"doc_id":"doc-live","page_id":"page-live"}]');`),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.clickup_sidecar_collection_parents
      where job_id='${job}' and parent_type='doc_page' and external_id='page-live';`),
    ).toBe("1");
    sql(`update public.clickup_sidecar_collection_parents set status='queued',claim_token=null,claimed_until=null
      where id='${inventory}';`);
  });

  it("heartbeat é CAS e parent falho não abandona os restantes", () => {
    const claimed = JSON.parse(
      sql(`select row_to_json(x) from public.fn_claim_clickup_live_sidecar_parent(
      '91040000-0000-4000-8000-000000000099',300) x;`),
    );
    expect(
      sql(`select public.fn_heartbeat_clickup_live_sidecar_parent('${GOV_ORG}',
      '${claimed.parent.id}','${claimed.parent.claim_token}',300);`),
    ).toBe("t");
    expect(
      sql(`select public.fn_finish_clickup_live_sidecar_parent('${GOV_ORG}',
      '${claimed.parent.id}','${claimed.parent.claim_token}','failed',null,null,'source_failed','sanitizado');`),
    ).toBe("t");
    expect(
      sql(
        `select status from public.clickup_sidecar_collection_jobs where id='${claimed.parent.job_id}';`,
      ),
    ).toBe("queued");
    expect(
      sql(
        `select count(*) from public.clickup_sidecar_collection_parents where job_id='${claimed.parent.job_id}' and status='queued';`,
      ),
    ).not.toBe("0");
  });

  it("marca término com erro e retoma somente os parents falhos", () => {
    const job = sql(`select id::text from public.clickup_sidecar_collection_jobs
      where organization_id='${GOV_ORG}' and run_id='${RUN}';`);
    sql(`update public.clickup_sidecar_collection_parents set status='completed',result='{}',
      claim_token=null,claimed_until=null where job_id='${job}';
      update public.clickup_sidecar_collection_parents set status='failed',result=null,
      error_code='source_failed' where id=(select id from public.clickup_sidecar_collection_parents
      where job_id='${job}' order by id limit 1);
      update public.clickup_sidecar_collection_jobs set status='queued' where id='${job}';`);
    expect(
      sql(`select count(*) from public.fn_claim_clickup_live_sidecar_parent(
        '91040000-0000-4000-8000-000000000099',300);`),
    ).toBe("0");
    expect(
      sql(`select status||':'||(finished_at is not null)::text
        from public.clickup_sidecar_collection_jobs where id='${job}';`),
    ).toBe("completed_with_errors:true");
    expect(
      sql(`select public.fn_start_clickup_live_sidecar(
        '${GOV_ORG}','${RUN}','inventory',true,'${GOV_ADMIN}')::text;`),
    ).toBe(job);
    expect(
      sql(`select j.status||':'||(j.finished_at is null)::text||':'||(
        select count(*) from public.clickup_sidecar_collection_parents p
        where p.job_id=j.id and p.status='queued') from public.clickup_sidecar_collection_jobs j
        where j.id='${job}';`),
    ).toBe("queued:true:1");
  });

  it("não persiste token, Authorization ou URL assinada", () => {
    expect(
      sql(`select count(*) from public.clickup_sidecar_collection_parents
      where coalesce(result::text,'') ~* '(authorization|x-amz-signature|https?://|[?&](token|sig)=)';`),
    ).toBe("0");
  });
});
