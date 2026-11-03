import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, GOV_PIPELINE, GOV_STAGE, seedGov, sql } from "./gov-helpers";

const CONNECTION = "90960000-1000-4000-8000-000000000001";
const RUN = "90960000-1000-4000-8000-000000000002";
const ITEM = "90960000-1000-4000-8000-000000000003";
const WORKER_A = "90960000-1000-4000-8000-000000000004";
const WORKER_B = "90960000-1000-4000-8000-000000000005";
const LEASE = "90960000-1000-4000-8000-000000000006";
const CLAIM = "90960000-1000-4000-8000-000000000007";

describe("W3.1 — segurança do apply CRM ClickUp", () => {
  beforeAll(() => {
    seedGov();
    sql(`insert into public.clickup_connections
      (id, organization_id, workspace_id, workspace_name, token_ciphertext, token_iv,
       token_tag, token_last4, created_by)
      values ('${CONNECTION}', '${GOV_ORG}', 'wk-safety', 'Safety', '\\x01',
        decode(repeat('01',12),'hex'), decode(repeat('02',16),'hex'), '1234', '${GOV_ADMIN}');
      insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, source, scope, status, snapshot_hash,
       lease_owner, lease_token, lease_expires_at, heartbeat_at, started_at)
      values ('${RUN}', '${GOV_ORG}', '${CONNECTION}', 'wk-safety', 'bundle', 'crm', 'running',
        '${"a".repeat(64)}', '${WORKER_A}', '${LEASE}', now() + interval '5 minutes', now(),
        now() - interval '1 day');
      insert into public.clickup_import_processor_leases
      (run_id, processor, worker_id, lease_token, lease_expires_at, heartbeat_at)
      values ('${RUN}', 'crm', '${WORKER_A}', '${LEASE}', now() + interval '5 minutes', now());
      insert into public.clickup_import_items
      (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
       status, attempts, claim_token, claimed_until, result_kind)
      values ('${ITEM}', '${GOV_ORG}', '${RUN}', 'wk-safety', 'task', 'task-safety',
        '${"b".repeat(64)}', 'processing', 1, '${CLAIM}', now() + interval '5 minutes', 'created');`);
  });

  it("não permite roubar lease ativo e preserva o mesmo worker", () => {
    expect(
      sql(`select coalesce((public.fn_claim_clickup_import_run_for_scope(
        '${WORKER_B}', 'crm', 90)).id::text, '');`),
    ).toBe("");
    expect(
      sql(`select worker_id::text from public.clickup_import_processor_leases
        where run_id = '${RUN}' and processor = 'crm';`),
    ).toBe(WORKER_A);
    expect(
      sql(`select (public.fn_claim_clickup_import_run_for_scope(
        '${WORKER_A}', 'crm', 90)).id::text;`),
    ).toBe(RUN);
    sql(`update public.clickup_import_processor_leases set lease_expires_at = now() - interval '1 second'
      where run_id = '${RUN}' and processor = 'crm';`);
    expect(
      sql(`select (public.fn_claim_clickup_import_run_for_scope(
        '${WORKER_B}', 'crm', 90)).id::text;`),
    ).toBe(RUN);
    expect(
      sql(`select worker_id::text from public.clickup_import_processor_leases
        where run_id = '${RUN}' and processor = 'crm';`),
    ).toBe(WORKER_B);
  });

  it("não troca created por unchanged após crash entre mark e finish", () => {
    expect(
      sql(`select public.fn_mark_clickup_import_item_result(
        '${GOV_ORG}', '${ITEM}', '${CLAIM}', 'unchanged');`),
    ).toBe("t");
    expect(sql(`select result_kind from public.clickup_import_items where id = '${ITEM}';`)).toBe(
      "created",
    );
  });

  it("mantém staging de bundle privado e limitado", () => {
    expect(
      sql(`select (not public)::text || ':' || file_size_limit::text
        from storage.buckets where id = 'clickup-import-staging';`),
    ).toBe("true:20971520");
  });

  it("inserir lead ClickUp não emite automação, CAPI, webhook ou outbox", () => {
    const before = sql(`select jsonb_build_object(
      'events', (select count(*) from public.event_log where organization_id = '${GOV_ORG}'),
      'webhooks', (select count(*) from public.webhook_events_log where organization_id = '${GOV_ORG}'),
      'automations', (select count(*) from public.automation_rule_runs where organization_id = '${GOV_ORG}'),
      'capi', (select count(*) from public.ad_conversion_dispatches where organization_id = '${GOV_ORG}'),
      'ctwa', (select count(*) from public.meta_ctwa_click_dispatches where organization_id = '${GOV_ORG}')
    )::text;`);
    sql(`insert into public.crm_leads
      (id, organization_id, pipeline_id, stage_id, title, status, source, external_id)
      values ('90960000-1000-4000-8000-000000000008', '${GOV_ORG}', '${GOV_PIPELINE}',
        '${GOV_STAGE}', 'ClickUp sem efeitos', 'open', 'clickup', 'task-no-side-effects');`);
    const after = sql(`select jsonb_build_object(
      'events', (select count(*) from public.event_log where organization_id = '${GOV_ORG}'),
      'webhooks', (select count(*) from public.webhook_events_log where organization_id = '${GOV_ORG}'),
      'automations', (select count(*) from public.automation_rule_runs where organization_id = '${GOV_ORG}'),
      'capi', (select count(*) from public.ad_conversion_dispatches where organization_id = '${GOV_ORG}'),
      'ctwa', (select count(*) from public.meta_ctwa_click_dispatches where organization_id = '${GOV_ORG}')
    )::text;`);
    expect(JSON.parse(after)).toEqual(JSON.parse(before));
  });
});
