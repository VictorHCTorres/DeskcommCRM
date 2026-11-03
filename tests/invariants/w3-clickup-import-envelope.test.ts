import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  countAs,
  seedGov,
  sql,
} from "./gov-helpers";

const CONNECTION = "90950000-0000-4000-8000-000000000001";
const RUN = "90950000-0000-4000-8000-000000000002";
const TASK_ITEM = "90950000-0000-4000-8000-000000000003";
const DOC_ITEM = "90950000-0000-4000-8000-000000000004";
const MAP_PIPELINE = "90950000-0000-4000-8000-000000000005";
const RUN_CANCEL = "90950000-0000-4000-8000-000000000006";
const ITEM_CANCEL = "90950000-0000-4000-8000-000000000007";
const RUN_RETRY_EMPTY = "90950000-0000-4000-8000-000000000008";
const RUN_EXHAUSTED = "90950000-0000-4000-8000-000000000009";
const OTHER_CONNECTION = "90950000-0000-4000-8000-000000000012";
const RUN_SUSPENDED = "90950000-0000-4000-8000-000000000013";
const RUN_MAX_ATTEMPTS = "90950000-0000-4000-8000-000000000014";
const RUN_RETRY_ELIGIBLE = "90950000-0000-4000-8000-000000000015";
const OTHER_MANAGER = "90950000-0000-4000-8000-000000000016";
const OTHER_RUN = "90950000-0000-4000-8000-000000000017";
const OTHER_ITEM = "90950000-0000-4000-8000-000000000018";
const OTHER_MAPPING = "90950000-0000-4000-8000-000000000019";
const FULL_DOC_PURGE = "90950000-0000-4000-8000-000000000020";
const RUN_BLOCKED_CANCEL = "90950000-0000-4000-8000-000000000021";
const ITEM_BLOCKED_CANCEL = "90950000-0000-4000-8000-000000000022";
const ITEM_CANCEL_BLOCKED = "90950000-0000-4000-8000-000000000023";
const RUN_RECOVERY_CANCEL = "90950000-0000-4000-8000-000000000024";
const ITEM_RECOVERY_CANCEL = "90950000-0000-4000-8000-000000000025";
const RUN_PURGE = "90950000-0000-4000-8000-000000000026";
const FULL_DOC_PURGE_TERMINAL = "90950000-0000-4000-8000-000000000027";
const RUN_EXECUTE_EXPIRED = "90950000-0000-4000-8000-000000000028";
const FULL_DOC_EXECUTE_EXPIRED = "90950000-0000-4000-8000-000000000029";
const OUTRA_ORG = "90950000-0000-4000-8000-000000000010";
const OUTRO_PIPELINE = "90950000-0000-4000-8000-000000000011";
const HASH = "a".repeat(64);
const MAPPING_HASH = "b".repeat(64);

describe("W3.0 — envelope de importação ClickUp", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${OUTRA_ORG}', 'w3-outra', 'W3 Outra', 'W3 Outra') on conflict do nothing;
      insert into auth.users (id, email)
        values ('${OTHER_MANAGER}', 'w3-other-manager@invariant.test') on conflict do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${OTHER_MANAGER}', '${OUTRA_ORG}', 'admin', now()) on conflict do nothing;
      insert into public.crm_pipelines (id, organization_id, name, slug, position)
        values ('${OUTRO_PIPELINE}', '${OUTRA_ORG}', 'Pipeline externo W3', 'externo-w3', 1)
        on conflict do nothing;
      insert into public.clickup_connections
        (id, organization_id, workspace_id, workspace_name, token_ciphertext, token_iv,
         token_tag, token_last4, created_by)
      values ('${CONNECTION}', '${GOV_ORG}', 'wk-1', 'Workspace W3', '\\x0102',
        decode(repeat('01', 12), 'hex'), decode(repeat('02', 16), 'hex'), '1234', '${GOV_ADMIN}')
      on conflict do nothing;
      insert into public.clickup_connections
        (id, organization_id, workspace_id, workspace_name, token_ciphertext, token_iv,
         token_tag, token_last4, created_by)
      values ('${OTHER_CONNECTION}', '${OUTRA_ORG}', 'wk-other', 'Workspace externo', '\\x03',
        decode(repeat('03', 12), 'hex'), decode(repeat('04', 16), 'hex'), '5678', '${OTHER_MANAGER}')
      on conflict do nothing;
      insert into public.clickup_import_runs
        (id, organization_id, connection_id, workspace_id, source, scope, status,
         manifest_version, snapshot_hash, preview_revision, created_by)
      values ('${RUN}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'bundle', 'crm', 'ready',
        1, '${HASH}', 1, '${GOV_MANAGER}') on conflict do nothing;
      insert into public.clickup_import_items
        (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
         source_metadata, content_access, execution_blocked, blocked_reason, status)
      values
        ('${TASK_ITEM}', '${GOV_ORG}', '${RUN}', 'wk-1', 'task', 'task-1', '${HASH}',
          '{"name":"Tarefa sem PII"}', 'none', false, null, 'ready'),
        ('${DOC_ITEM}', '${GOV_ORG}', '${RUN}', 'wk-1', 'doc', 'doc-1', '${HASH}',
          '{"name":"Documento sem conteúdo"}', 'metadata_only', true,
          'clickup_doc_content_not_authorized', 'blocked')
      on conflict do nothing;
      insert into public.clickup_import_runs
        (id, organization_id, connection_id, workspace_id, source, scope, status,
         manifest_version, snapshot_hash, preview_revision, created_by)
      values ('${OTHER_RUN}', '${OUTRA_ORG}', '${OTHER_CONNECTION}', 'wk-other', 'bundle',
        'crm', 'ready', 1, '${"9".repeat(64)}', 1, '${OTHER_MANAGER}') on conflict do nothing;
      insert into public.clickup_import_items
        (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
         source_metadata, content_access, execution_blocked, status)
      values ('${OTHER_ITEM}', '${OUTRA_ORG}', '${OTHER_RUN}', 'wk-other', 'list',
        'other-list', '${HASH}', '{}', 'none', false, 'ready') on conflict do nothing;
      insert into public.clickup_object_mappings
        (id, organization_id, connection_id, workspace_id, entity_type, external_id,
         source_hash, pipeline_id, created_by)
      values ('${OTHER_MAPPING}', '${OUTRA_ORG}', '${OTHER_CONNECTION}', 'wk-other', 'list',
        'other-list', '${HASH}', '${OUTRO_PIPELINE}', '${OTHER_MANAGER}') on conflict do nothing;
      insert into public.clickup_object_mappings
        (id, organization_id, connection_id, workspace_id, entity_type, external_id,
         source_hash, pipeline_id, mapping_revision, created_by)
      values ('${MAP_PIPELINE}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'list', 'list-1',
        '${HASH}', '${GOV_PIPELINE}', 1, '${GOV_MANAGER}') on conflict do nothing;
    `);
  });

  it("expõe conexão somente pela view segura para admin e nunca concede bytes a authenticated", () => {
    expect(
      countAs(
        GOV_ADMIN,
        `select count(*) from public.clickup_connections_safe where id = '${CONNECTION}';`,
      ),
    ).toBe(1);
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.clickup_connections_safe where id = '${CONNECTION}';`,
      ),
    ).toBe(0);
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}"}', false);
        select token_ciphertext from public.clickup_connections where id = '${CONNECTION}';`),
    ).toThrow();
    expect(
      sql(`select count(*) from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'clickup_connections'
          and grantee = 'authenticated';`),
    ).toBe("0");
  });

  it("mantém runs/items no tenant, visíveis a manager+ e invisíveis a agent", () => {
    expect(
      countAs(GOV_MANAGER, `select count(*) from public.clickup_import_runs where id = '${RUN}';`),
    ).toBe(1);
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.clickup_import_runs where id = '${RUN}';`),
    ).toBe(0);
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.clickup_import_items where run_id = '${RUN}';`,
      ),
    ).toBe(2);
    expect(() =>
      sql(`insert into public.clickup_import_runs
        (organization_id, connection_id, workspace_id, snapshot_hash)
        values ('${OUTRA_ORG}', '${CONNECTION}', 'wk-1', '${HASH}');`),
    ).toThrow();
  });

  it("prova controles positivos e zero cross-tenant nas quatro projeções W3", () => {
    expect(countAs(GOV_ADMIN, `select count(*) from public.clickup_connections_safe;`)).toBe(1);
    expect(
      countAs(
        GOV_ADMIN,
        `select count(*) from public.clickup_connections_safe where id = '${OTHER_CONNECTION}';`,
      ),
    ).toBe(0);
    expect(countAs(OTHER_MANAGER, `select count(*) from public.clickup_connections_safe;`)).toBe(1);
    expect(
      countAs(
        OTHER_MANAGER,
        `select count(*) from public.clickup_connections_safe where id = '${CONNECTION}';`,
      ),
    ).toBe(0);
    expect(
      countAs(
        OTHER_MANAGER,
        `select count(*) from public.clickup_import_runs where id = '${OTHER_RUN}';`,
      ),
    ).toBe(1);
    expect(
      countAs(
        OTHER_MANAGER,
        `select count(*) from public.clickup_import_runs where id = '${RUN}';`,
      ),
    ).toBe(0);
    expect(
      countAs(
        OTHER_MANAGER,
        `select count(*) from public.clickup_import_items where id = '${OTHER_ITEM}';`,
      ),
    ).toBe(1);
    expect(
      countAs(
        OTHER_MANAGER,
        `select count(*) from public.clickup_import_items where id = '${TASK_ITEM}';`,
      ),
    ).toBe(0);
    expect(
      countAs(
        OTHER_MANAGER,
        `select count(*) from public.clickup_object_mappings where id = '${OTHER_MAPPING}';`,
      ),
    ).toBe(1);
    expect(
      countAs(
        OTHER_MANAGER,
        `select count(*) from public.clickup_object_mappings where id = '${MAP_PIPELINE}';`,
      ),
    ).toBe(0);
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.clickup_object_mappings where id = '${MAP_PIPELINE}';`,
      ),
    ).toBe(1);
  });

  it("RPCs acionadas pelas rotas retornam somente UUID, nunca composite interno", () => {
    expect(
      sql(`select count(*) from pg_proc
        where oid in (
          'public.fn_execute_clickup_import_run(uuid,uuid,integer,text,text,boolean)'::regprocedure,
          'public.fn_update_clickup_import_mapping(uuid,uuid,integer,jsonb,text)'::regprocedure,
          'public.fn_retry_clickup_import_run(uuid,uuid)'::regprocedure,
          'public.fn_cancel_clickup_import_run(uuid,uuid)'::regprocedure
        ) and pg_get_function_result(oid) = 'uuid';`),
    ).toBe("4");
  });

  it("impõe contrato de Docs e retenção máxima de 30 dias ao payload bruto", () => {
    expect(() =>
      sql(`insert into public.clickup_import_items
        (organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
         content_access, execution_blocked, status)
        values ('${GOV_ORG}', '${RUN}', 'wk-1', 'doc', 'doc-invalido', '${HASH}',
          'metadata_only', false, 'ready');`),
    ).toThrow();
    expect(() =>
      sql(`insert into public.clickup_import_items
        (organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
         content_access, execution_blocked, status)
        values ('${GOV_ORG}', '${RUN}', 'wk-1', 'doc', 'doc-full-sem-payload', '${HASH}',
          'full', false, 'ready');`),
    ).toThrow();
    expect(() =>
      sql(`insert into public.clickup_import_items
        (organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
         source_payload, payload_expires_at, status)
        values ('${GOV_ORG}', '${RUN}', 'wk-1', 'task', 'payload-longo', '${HASH}',
          '{"raw":true}', now() + interval '31 days', 'ready');`),
    ).toThrow();
    expect(() =>
      sql(`insert into public.clickup_object_mappings
        (organization_id, connection_id, workspace_id, entity_type, external_id,
         source_hash, stage_id)
        values ('${GOV_ORG}', '${CONNECTION}', 'wk-1', 'list', 'lista-em-etapa',
          '${HASH}', 'cccccccc-5555-4000-8000-000000000002');`),
    ).toThrow();
    sql(`insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash)
      values ('${RUN_PURGE}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'ready',
        '${"8".repeat(64)}');
      insert into public.clickup_import_items
      (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
       source_payload, payload_expires_at, content_access, execution_blocked, status, created_at)
      values
        ('${FULL_DOC_PURGE}', '${GOV_ORG}', '${RUN_PURGE}', 'wk-1', 'doc', 'doc-expirado',
          '${HASH}', '{"format":"markdown","content":"Conteúdo temporário"}',
          now() - interval '1 day', 'full', false, 'ready', now() - interval '2 days'),
        ('${FULL_DOC_PURGE_TERMINAL}', '${GOV_ORG}', '${RUN_PURGE}', 'wk-1', 'doc',
          'doc-expirado-terminal', '${HASH}',
          '{"format":"markdown","content":"Conteúdo terminal"}',
          now() - interval '1 day', 'full', false, 'skipped', now() - interval '2 days');`);
    expect(sql(`select public.fn_purge_expired_clickup_payloads(10)::text;`)).toBe("2");
    expect(
      sql(`select status || ':' || execution_blocked || ':' || blocked_reason || ':' ||
        (source_payload is null and payload_purged_at is not null)::text
      from public.clickup_import_items where id = '${FULL_DOC_PURGE}';`),
    ).toBe("blocked:true:clickup_doc_payload_expired:true");
    expect(
      sql(`select status || ':' || execution_blocked || ':' ||
        (source_payload is null and payload_purged_at is not null)::text
        from public.clickup_import_items where id = '${FULL_DOC_PURGE_TERMINAL}';`),
    ).toBe("skipped:false:true");
    expect(
      sql(`select status || ':' || error_code || ':' || total_items || ':' ||
        applicable_items || ':' || warnings_count || ':' || skipped_items
        from public.clickup_import_runs where id = '${RUN_PURGE}';`),
    ).toBe("blocked_missing_content:clickup_doc_payload_expired:2:1:1:1");
    expect(() =>
      sql(`select public.fn_execute_clickup_import_run('${GOV_ORG}', '${RUN_PURGE}', 1,
        '${"8".repeat(64)}', null, true);`),
    ).toThrow();
    expect(
      sql(`select status from public.clickup_import_items where id = '${FULL_DOC_PURGE}';`),
    ).toBe("blocked");

    sql(`insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash)
      values ('${RUN_EXECUTE_EXPIRED}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'ready',
        '${"0".repeat(64)}');
      insert into public.clickup_import_items
      (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
       source_payload, payload_expires_at, content_access, execution_blocked, status, created_at)
      values ('${FULL_DOC_EXECUTE_EXPIRED}', '${GOV_ORG}', '${RUN_EXECUTE_EXPIRED}', 'wk-1',
        'doc_page', 'doc-expirado-no-execute', '${HASH}',
        '{"format":"text","content":"Não pode entrar na fila"}',
        now() - interval '1 day', 'full', false, 'ready', now() - interval '2 days');`);
    expect(
      sql(`select public.fn_execute_clickup_import_run('${GOV_ORG}',
        '${RUN_EXECUTE_EXPIRED}', 1, '${"0".repeat(64)}', null, true)::text;`),
    ).toBe(RUN_EXECUTE_EXPIRED);
    expect(
      sql(`select r.status || ':' || r.error_code || ':' || i.status || ':' ||
        i.execution_blocked from public.clickup_import_runs r
        join public.clickup_import_items i on i.run_id = r.id
        where r.id = '${RUN_EXECUTE_EXPIRED}';`),
    ).toBe("blocked_missing_content:clickup_doc_payload_expired:blocked:true");
  });

  it("mapeamento durável aceita exatamente um alvo explícito e fecha FK cross-org", () => {
    sql(`insert into public.clickup_object_mappings
      (id, organization_id, connection_id, workspace_id, entity_type, external_id,
       source_hash, pipeline_id, mapping_revision, created_by)
      values ('${MAP_PIPELINE}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'list', 'list-1',
        '${HASH}', '${GOV_PIPELINE}', 1, '${GOV_MANAGER}') on conflict do nothing;`);
    expect(() =>
      sql(`insert into public.clickup_object_mappings
        (organization_id, connection_id, workspace_id, entity_type, external_id,
         source_hash, pipeline_id, lead_id)
        values ('${GOV_ORG}', '${CONNECTION}', 'wk-1', 'task', 'dois-alvos',
          '${HASH}', '${GOV_PIPELINE}', 'cccccccc-6666-4000-8000-000000000001');`),
    ).toThrow();
    expect(() =>
      sql(`insert into public.clickup_object_mappings
        (organization_id, connection_id, workspace_id, entity_type, external_id,
         source_hash, pipeline_id)
        values ('${GOV_ORG}', '${CONNECTION}', 'wk-1', 'list', 'cross-org',
          '${HASH}', '${OUTRO_PIPELINE}');`),
    ).toThrow();
    expect(() =>
      sql(`insert into public.clickup_object_mappings
        (organization_id, connection_id, workspace_id, entity_type, external_id,
         source_hash, pipeline_id)
        values ('${GOV_ORG}', '${CONNECTION}', 'wk-1', 'custom_field', 'campo-sem-chave',
          '${HASH}', '${GOV_PIPELINE}');`),
    ).toThrow();
  });

  it("execute usa CAS, só aceita dry-run e claim de item recupera lease expirada", () => {
    expect(
      sql(`select public.fn_update_clickup_import_mapping(
        '${GOV_ORG}', '${RUN}', 0, '{"objects":[]}', '${MAPPING_HASH}')::text;`),
    ).toBe(RUN);
    expect(
      sql(`select preview_revision || ':' || mapping_revision
        from public.clickup_import_runs where id = '${RUN}';`),
    ).toBe("2:1");
    expect(() =>
      sql(`select public.fn_execute_clickup_import_run('${GOV_ORG}', '${RUN}', 2,
        '${"c".repeat(64)}', '${MAPPING_HASH}', true);`),
    ).toThrow();
    expect(() =>
      sql(`select public.fn_execute_clickup_import_run('${GOV_ORG}', '${RUN}', 1,
        '${HASH}', '${MAPPING_HASH}', true);`),
    ).toThrow();
    expect(() =>
      sql(`select public.fn_execute_clickup_import_run('${GOV_ORG}', '${RUN}', 2,
        '${HASH}', '${MAPPING_HASH}', false);`),
    ).toThrow();
    expect(
      sql(`select public.fn_execute_clickup_import_run('${GOV_ORG}', '${RUN}', 2,
        '${HASH}', '${MAPPING_HASH}', true)::text;`),
    ).toBe(RUN);
    expect(sql(`select status from public.clickup_import_runs where id = '${RUN}';`)).toBe(
      "queued",
    );
    expect(
      sql(
        `select (public.fn_claim_clickup_import_run('90950000-0000-4000-8000-000000000099', 30)).status;`,
      ),
    ).toBe("running");
    expect(
      sql(`select (public.fn_claim_clickup_import_item('${GOV_ORG}', '${RUN}', 30)).id::text;`),
    ).toBe(TASK_ITEM);
    expect(
      sql(`select (public.fn_claim_clickup_import_item('${GOV_ORG}', '${RUN}', 30)).id::text;`),
    ).toBe("");
    sql(`update public.clickup_import_items set claimed_until = now() - interval '1 second'
      where id = '${TASK_ITEM}';`);
    expect(
      sql(`select (public.fn_claim_clickup_import_item('${GOV_ORG}', '${RUN}', 30)).id::text;`),
    ).toBe(TASK_ITEM);
    expect(
      sql(`select attempts::text from public.clickup_import_items where id = '${TASK_ITEM}';`),
    ).toBe("2");
    const claimToken = sql(
      `select claim_token::text from public.clickup_import_items where id = '${TASK_ITEM}';`,
    );
    expect(
      sql(`select public.fn_finish_clickup_import_item('${GOV_ORG}', '${TASK_ITEM}',
        '90950000-0000-4000-8000-000000000098', 'succeeded');`),
    ).toBe("f");
    expect(sql(`select status from public.clickup_import_items where id = '${TASK_ITEM}';`)).toBe(
      "processing",
    );
    expect(
      sql(`select public.fn_finish_clickup_import_item('${GOV_ORG}', '${TASK_ITEM}',
        '${claimToken}', 'succeeded');`),
    ).toBe("t");
    expect(sql(`select status from public.clickup_import_items where id = '${DOC_ITEM}';`)).toBe(
      "blocked",
    );
    expect(
      sql(`select status || ':' || total_items || ':' || applicable_items || ':' ||
        warnings_count || ':' || succeeded_items from public.clickup_import_runs where id = '${RUN}';`),
    ).toBe("completed:2:1:1:1");
  });

  it("preview é transacional e Docs full inválido não deixa run parcial", () => {
    const snapshot = "d".repeat(64);
    const validSnapshot = "4".repeat(64);
    expect(() =>
      sql(`select public.fn_stage_clickup_import_preview(
        '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'bundle', 'docs', 1, '${snapshot}', null,
        '${GOV_MANAGER}',
        '[{"entity_type":"doc","external_id":"doc-rpc-invalido","source_hash":"${HASH}",
          "source_metadata":{},"source_payload":null,"content_access":"full",
          "execution_blocked":false,"blocked_reason":null,"status":"ready"}]'::jsonb);`),
    ).toThrow();
    expect(
      sql(`select count(*) from public.clickup_import_runs where snapshot_hash = '${snapshot}';`),
    ).toBe("0");
    sql(`select public.fn_stage_clickup_import_preview(
      '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'bundle', 'docs', 1, '${validSnapshot}', null,
      '${GOV_MANAGER}',
      '[{"entity_type":"doc_page","external_id":"doc-rpc-valido","source_hash":"${HASH}",
        "source_metadata":{},
        "source_payload":{"format":"markdown","content":"Conteúdo autorizado"},
        "content_access":"full","execution_blocked":false,"blocked_reason":null,
        "status":"ready"}]'::jsonb);`);
    expect(
      sql(`select r.status || ':' || count(i.id) from public.clickup_import_runs r
        join public.clickup_import_items i on i.run_id = r.id
        where r.snapshot_hash = '${validSnapshot}' group by r.status;`),
    ).toBe("ready:1");
  });

  it("retry recusa run sem item elegível e teto de tentativas", () => {
    sql(`insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash, finished_at)
      values ('${RUN_RETRY_EMPTY}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'failed',
        '${"e".repeat(64)}', now());
      insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash, finished_at)
      values ('${RUN_EXHAUSTED}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'failed',
        '${"f".repeat(64)}', now());
      insert into public.clickup_import_items
      (organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
       status, attempts, max_attempts, error_code)
      values ('${GOV_ORG}', '${RUN_EXHAUSTED}', 'wk-1', 'task', 'exaurido', '${HASH}',
        'failed', 5, 5, 'attempts_exhausted');`);
    sql(`insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash, finished_at)
      values ('${RUN_RETRY_ELIGIBLE}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'failed',
        '${"5".repeat(64)}', now());
      insert into public.clickup_import_items
      (organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
       status, attempts, max_attempts, error_code)
      values ('${GOV_ORG}', '${RUN_RETRY_ELIGIBLE}', 'wk-1', 'task', 'elegivel', '${HASH}',
        'failed', 1, 5, 'transient_error');`);
    expect(() =>
      sql(`select public.fn_retry_clickup_import_run('${GOV_ORG}', '${RUN_RETRY_EMPTY}');`),
    ).toThrow();
    expect(() =>
      sql(`select public.fn_retry_clickup_import_run('${GOV_ORG}', '${RUN_EXHAUSTED}');`),
    ).toThrow();
    expect(() =>
      sql(`select public.fn_cancel_clickup_import_run('${GOV_ORG}', '${RUN_EXHAUSTED}');`),
    ).toThrow();
    expect(
      sql(`select status from public.clickup_import_runs where id = '${RUN_EXHAUSTED}';`),
    ).toBe("failed");
    expect(
      sql(
        `select public.fn_retry_clickup_import_run('${GOV_ORG}', '${RUN_RETRY_ELIGIBLE}')::text;`,
      ),
    ).toBe(RUN_RETRY_ELIGIBLE);
    expect(
      sql(`select r.status || ':' || i.status from public.clickup_import_runs r
        join public.clickup_import_items i on i.run_id = r.id
        where r.id = '${RUN_RETRY_ELIGIBLE}';`),
    ).toBe("queued:queued");
    sql(`select public.fn_cancel_clickup_import_run('${GOV_ORG}', '${RUN_RETRY_ELIGIBLE}');`);
  });

  it("cancel running corta heartbeat/claim e converge por ack CAS do lease", () => {
    sql(`insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash)
      values ('${RUN_CANCEL}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'ready', '${"1".repeat(64)}');
      insert into public.clickup_import_items
      (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash, status)
      values ('${ITEM_CANCEL}', '${GOV_ORG}', '${RUN_CANCEL}', 'wk-1', 'task', 'cancelar',
        '${HASH}', 'ready');
      insert into public.clickup_import_items
      (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
       content_access, execution_blocked, blocked_reason, status)
      values ('${ITEM_CANCEL_BLOCKED}', '${GOV_ORG}', '${RUN_CANCEL}', 'wk-1', 'doc',
        'doc-bloqueado-running', '${HASH}', 'metadata_only', true,
        'clickup_doc_content_not_authorized', 'blocked');
      select public.fn_execute_clickup_import_run(
        '${GOV_ORG}', '${RUN_CANCEL}', 1, '${"1".repeat(64)}', null, true);
      select public.fn_claim_clickup_import_run('90950000-0000-4000-8000-000000000097', 30);`);
    const leaseToken = sql(
      `select lease_token::text from public.clickup_import_runs where id = '${RUN_CANCEL}';`,
    );
    expect(
      sql(`select public.fn_cancel_clickup_import_run('${GOV_ORG}', '${RUN_CANCEL}')::text;`),
    ).toBe(RUN_CANCEL);
    expect(
      sql(`select public.fn_heartbeat_clickup_import_run('${RUN_CANCEL}',
        '90950000-0000-4000-8000-000000000097', '${leaseToken}', null, 30);`),
    ).toBe("f");
    expect(
      sql(
        `select (public.fn_claim_clickup_import_item('${GOV_ORG}', '${RUN_CANCEL}', 30)).id::text;`,
      ),
    ).toBe("");
    expect(
      sql(`select public.fn_ack_cancel_clickup_import_run('${GOV_ORG}', '${RUN_CANCEL}',
        '90950000-0000-4000-8000-000000000097',
        '90950000-0000-4000-8000-000000000096');`),
    ).toBe("f");
    expect(
      sql(`select public.fn_ack_cancel_clickup_import_run('${GOV_ORG}', '${RUN_CANCEL}',
        '90950000-0000-4000-8000-000000000097', '${leaseToken}');`),
    ).toBe("t");
    expect(sql(`select status from public.clickup_import_runs where id = '${RUN_CANCEL}';`)).toBe(
      "cancelled",
    );
    expect(
      sql(`select string_agg(status, ',' order by status) from public.clickup_import_items
        where run_id = '${RUN_CANCEL}';`),
    ).toBe("blocked,cancelled");
    expect(() =>
      sql(`update public.clickup_import_runs set status = 'queued' where id = '${RUN_CANCEL}';`),
    ).toThrow();
  });

  it("cancelamento preserva blocked e recovery prioriza cancel mesmo no teto", () => {
    sql(`insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash)
      values ('${RUN_BLOCKED_CANCEL}', '${GOV_ORG}', '${CONNECTION}', 'wk-1',
        'blocked_missing_content', '${"6".repeat(64)}');
      insert into public.clickup_import_items
      (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
       content_access, execution_blocked, blocked_reason, status)
      values ('${ITEM_BLOCKED_CANCEL}', '${GOV_ORG}', '${RUN_BLOCKED_CANCEL}', 'wk-1', 'doc',
        'doc-bloqueado', '${HASH}', 'metadata_only', true,
        'clickup_doc_content_not_authorized', 'blocked');
      select public.fn_cancel_clickup_import_run('${GOV_ORG}', '${RUN_BLOCKED_CANCEL}');`);
    expect(
      sql(`select r.status || ':' || i.status from public.clickup_import_runs r
        join public.clickup_import_items i on i.run_id = r.id
        where r.id = '${RUN_BLOCKED_CANCEL}';`),
    ).toBe("cancelled:blocked");

    sql(`insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash,
       attempt, max_attempts, lease_owner, lease_token, lease_expires_at, heartbeat_at,
       cancel_requested_at)
      values ('${RUN_RECOVERY_CANCEL}', '${GOV_ORG}', '${CONNECTION}', 'wk-1', 'running',
        '${"7".repeat(64)}', 2, 2, '90950000-0000-4000-8000-000000000094',
        '90950000-0000-4000-8000-000000000093', now() - interval '1 second',
        now() - interval '2 seconds', now() - interval '3 seconds');
      insert into public.clickup_import_items
      (id, organization_id, run_id, workspace_id, entity_type, external_id, source_hash, status)
      values ('${ITEM_RECOVERY_CANCEL}', '${GOV_ORG}', '${RUN_RECOVERY_CANCEL}', 'wk-1',
        'task', 'cancel-recovery-max', '${HASH}', 'queued');
      select public.fn_claim_clickup_import_run(
        '90950000-0000-4000-8000-000000000092', 30);`);
    expect(
      sql(`select r.status || ':' || r.error_code || ':' || i.status
        from public.clickup_import_runs r join public.clickup_import_items i on i.run_id = r.id
        where r.id = '${RUN_RECOVERY_CANCEL}';`),
    ).toBe("cancelled:cancelled:cancelled");
  });

  it("claim ignora organização suspensa e terminaliza run no teto", () => {
    sql(`insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash)
      values ('${RUN_SUSPENDED}', '${OUTRA_ORG}', '${OTHER_CONNECTION}', 'wk-other',
        'queued', '${"2".repeat(64)}');
      insert into public.clickup_import_runs
      (id, organization_id, connection_id, workspace_id, status, snapshot_hash,
       attempt, max_attempts)
      values ('${RUN_MAX_ATTEMPTS}', '${GOV_ORG}', '${CONNECTION}', 'wk-1',
        'queued', '${"3".repeat(64)}', 1, 1);
      update public.organizations set status = 'suspended' where id = '${OUTRA_ORG}';`);
    expect(
      sql(`select (public.fn_claim_clickup_import_run(
        '90950000-0000-4000-8000-000000000095', 30)).id::text;`),
    ).toBe("");
    expect(
      sql(`select status || ':' || error_code from public.clickup_import_runs
        where id = '${RUN_MAX_ATTEMPTS}';`),
    ).toBe("failed:run_attempts_exhausted");
    expect(
      sql(`select status from public.clickup_import_runs where id = '${RUN_SUSPENDED}';`),
    ).toBe("queued");
    sql(`update public.organizations set status = 'active' where id = '${OUTRA_ORG}';`);
  });

  it("contabiliza warning durável de anexos e restringe o resultado reconciliado", () => {
    const before = Number(
      sql(`select warnings_count from public.clickup_import_runs where id = '${RUN}';`),
    );
    sql(`insert into public.clickup_import_items
      (organization_id, run_id, workspace_id, entity_type, external_id, source_hash,
       source_metadata, status)
      values ('${GOV_ORG}', '${RUN}', 'wk-1', 'task', 'task-com-anexo', '${HASH}',
        '{"attachment_status":"skipped_not_imported","attachment_count":2}', 'ready');`);
    expect(sql(`select warnings_count from public.clickup_import_runs where id = '${RUN}';`)).toBe(
      String(before + 1),
    );
    expect(() =>
      sql(`update public.clickup_import_items set result_kind = 'falso_sucesso'
        where run_id = '${RUN}' and external_id = 'task-com-anexo';`),
    ).toThrow();
    sql(`update public.clickup_import_items set result_kind = 'unchanged'
      where run_id = '${RUN}' and external_id = 'task-com-anexo';`);
    expect(
      sql(`select result_kind from public.clickup_import_items
        where run_id = '${RUN}' and external_id = 'task-com-anexo';`),
    ).toBe("unchanged");
  });

  it("não concede escrita direta nem DELETE a authenticated e preserva histórico ao revogar conexão", () => {
    expect(
      sql(`select count(*) from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name in ('clickup_import_runs','clickup_import_items','clickup_object_mappings')
          and grantee = 'authenticated' and privilege_type <> 'SELECT';`),
    ).toBe("0");
    expect(
      sql(`select count(*) from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name like 'clickup_%' and privilege_type = 'DELETE'
          and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');`),
    ).toBe("0");
    sql(`update public.clickup_connections set status = 'revoked' where id = '${CONNECTION}';`);
    expect(sql(`select count(*) from public.clickup_import_runs where id = '${RUN}';`)).toBe("1");
  });
});
