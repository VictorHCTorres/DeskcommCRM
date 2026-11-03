import { beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_LEAD, GOV_MANAGER, GOV_ORG, countAs, seedGov, sql } from "./gov-helpers";

const CONNECTION = "90970000-0000-4000-8000-000000000001";
const RUN = "90970000-0000-4000-8000-000000000002";
const TASK = "90970000-0000-4000-8000-000000000003";
const SIDECAR = "90970000-0000-4000-8000-000000000004";
const UPLOAD = "90970000-0000-4000-8000-000000000005";
const UPLOAD_EXPIRED = "90970000-0000-4000-8000-000000000010";
const ASSET = "90970000-0000-4000-8000-000000000006";
const WORKER_A = "90970000-0000-4000-8000-000000000007";
const WORKER_B = "90970000-0000-4000-8000-000000000008";
const CLAIM = "90970000-0000-4000-8000-000000000009";
const RUN_COVERAGE = "90970000-0000-4000-8000-000000000011";
const HASH = "a".repeat(64);
const SOURCE_HASH = "b".repeat(64);

describe("W3.3 — sidecar, comentários e assets ClickUp", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into public.clickup_connections
        (id, organization_id, workspace_id, workspace_name, token_ciphertext, token_iv,
         token_tag, token_last4, created_by)
      values ('${CONNECTION}', '${GOV_ORG}', 'wk-assets', 'Assets', '\\x01',
        decode(repeat('01',12),'hex'), decode(repeat('02',16),'hex'), '1234', '${GOV_ADMIN}');
      insert into public.clickup_import_runs
        (id, organization_id, connection_id, workspace_id, source, scope, status,
         manifest_version, snapshot_hash, preview_revision, created_by)
      values ('${RUN}', '${GOV_ORG}', '${CONNECTION}', 'wk-assets', 'bundle', 'crm', 'ready',
        3, '${HASH}', 1, '${GOV_MANAGER}');
      insert into public.clickup_import_runs
        (id, organization_id, connection_id, workspace_id, source, scope, status,
         manifest_version, snapshot_hash, preview_revision, created_by)
      values ('${RUN_COVERAGE}', '${GOV_ORG}', '${CONNECTION}', 'wk-assets', 'bundle', 'all', 'ready',
        3, '${SOURCE_HASH}', 1, '${GOV_MANAGER}');
      insert into public.clickup_import_items
        (organization_id,run_id,workspace_id,entity_type,external_id,source_hash,
         source_metadata,content_access,execution_blocked,blocked_reason,status)
      values
        ('${GOV_ORG}','${RUN_COVERAGE}','wk-assets','task','task-coverage','${HASH}',
          '{}','none',false,null,'ready'),
        ('${GOV_ORG}','${RUN_COVERAGE}','wk-assets','doc','doc-coverage','${HASH}',
          '{"page_ids":["page-a","page-b"]}','metadata_only',true,
          'clickup_doc_content_not_authorized','blocked');
      insert into public.crm_tasks
        (id, organization_id, title, status, priority, lead_id, created_by)
      values ('${TASK}', '${GOV_ORG}', 'Tarefa ClickUp', 'pending', 'medium', '${GOV_LEAD}', '${GOV_MANAGER}');
    `);
  });

  it("mantém bucket privado sem policy browser e grants mínimos", () => {
    expect(
      sql(`select (not public)::text || ':' || file_size_limit::text
        from storage.buckets where id = 'clickup-assets';`),
    ).toBe("true:10485760");
    expect(
      sql(`select (not public)::text || ':' || file_size_limit::text || ':' ||
        (allowed_mime_types = array['application/json']::text[])::text
        from storage.buckets where id = 'clickup-sidecars';`),
    ).toBe("true:104857600:true");
    expect(
      sql(`select count(*) from pg_policies
        where schemaname = 'storage' and tablename = 'objects'
          and (qual ilike '%clickup-assets%' or with_check ilike '%clickup-assets%'
            or qual ilike '%clickup-sidecars%' or with_check ilike '%clickup-sidecars%');`),
    ).toBe("0");
    expect(
      sql(`select count(*) from information_schema.role_table_grants
        where table_schema='public'
          and table_name in ('clickup_asset_sidecars','clickup_asset_uploads','clickup_asset_items','clickup_asset_receipts','clickup_comment_receipts')
          and grantee in ('anon','authenticated');`),
    ).toBe("0");
  });

  it("grava comentário histórico no lead sem tocar relógio nem side effects e converge", () => {
    const before = sql(`select jsonb_build_object(
      'last', (select last_activity_at from public.crm_leads where id='${GOV_LEAD}'),
      'events', (select count(*) from public.event_log where organization_id='${GOV_ORG}'),
      'capi', (select count(*) from public.ad_conversion_dispatches where organization_id='${GOV_ORG}'),
      'webhooks', (select count(*) from public.webhook_events_log where organization_id='${GOV_ORG}'),
      'automations', (select count(*) from public.automation_rule_runs where organization_id='${GOV_ORG}')
    )::text;`);
    expect(
      JSON.parse(
        sql(`select public.fn_apply_clickup_lead_comment(
          '${GOV_ORG}','wk-assets','comment-1','${GOV_LEAD}','${SOURCE_HASH}',
          '2026-01-01T12:00:00Z',null,null,'user-1','Autor','Texto histórico')::text;`),
      ).result,
    ).toBe("created");
    expect(
      JSON.parse(
        sql(`select public.fn_apply_clickup_lead_comment(
          '${GOV_ORG}','wk-assets','comment-1','${GOV_LEAD}','${SOURCE_HASH}',
          '2026-01-01T12:00:00Z',null,null,'user-1','Autor','Texto histórico')::text;`),
      ).result,
    ).toBe("unchanged");
    const after = sql(`select jsonb_build_object(
      'last', (select last_activity_at from public.crm_leads where id='${GOV_LEAD}'),
      'events', (select count(*) from public.event_log where organization_id='${GOV_ORG}'),
      'capi', (select count(*) from public.ad_conversion_dispatches where organization_id='${GOV_ORG}'),
      'webhooks', (select count(*) from public.webhook_events_log where organization_id='${GOV_ORG}'),
      'automations', (select count(*) from public.automation_rule_runs where organization_id='${GOV_ORG}')
    )::text;`);
    expect(JSON.parse(after)).toEqual(JSON.parse(before));
    expect(() =>
      sql(`select public.fn_apply_clickup_lead_comment(
        '${GOV_ORG}','wk-assets','comment-1','${GOV_LEAD}','${"c".repeat(64)}',
        '2026-01-01T12:00:00Z',null,null,'user-1','Autor','Mudou');`),
    ).toThrow();
  });

  it("ancora coverage de Docs no manifesto e recusa comment_id cross-target", () => {
    const coverage = {
      tasks_expected: 1,
      tasks_comments_scanned: 1,
      attachment_parents_scanned: 3,
      terminal_cursors: [
        { kind: "tasks", parent_external_id: "task-coverage", cursor: null, terminal: true },
        {
          kind: "task_comments",
          parent_external_id: "task-coverage",
          cursor: null,
          terminal: true,
        },
        { kind: "doc_pages", parent_external_id: "page-a", cursor: null, terminal: true },
        { kind: "doc_pages", parent_external_id: "page-b", cursor: null, terminal: true },
      ],
      comments_found: 0,
      replies_found: 0,
      assets_found: 0,
      bytes_declared: 0,
      bytes_downloaded: 0,
      warnings: [],
      skips: [],
    };
    const sidecar = {
      sidecar_version: 1,
      manifest_version: 3,
      run_id: RUN_COVERAGE,
      workspace_id: "wk-assets",
      snapshot_hash: SOURCE_HASH,
      mode: "full",
      coverage,
      checkpoint: {
        parent_type: "doc_page",
        parent_external_id: "page-b",
        cursor: null,
        terminal: true,
      },
      comments: [],
      assets: [],
    };
    const stage = (value: unknown) =>
      sql(`select public.fn_stage_clickup_asset_sidecar(
        '${GOV_ORG}','${RUN_COVERAGE}','${GOV_MANAGER}','${JSON.stringify(value).replaceAll("'", "''")}'::jsonb);`);
    expect(() =>
      stage({
        ...sidecar,
        coverage: {
          ...coverage,
          attachment_parents_scanned: 2,
          terminal_cursors: coverage.terminal_cursors.filter(
            (cursor) => cursor.parent_external_id !== "page-b",
          ),
        },
      }),
    ).toThrow();
    expect(() =>
      stage({
        ...sidecar,
        mode: "inventory",
        comments: [{ comment_id: "comment-cross", task_id: "outra-task" }],
        assets: [
          {
            attachment_id: "asset-cross",
            parent_type: "task",
            parent_external_id: "task-coverage",
            comment_id: "comment-cross",
            file_name: "x.pdf",
            declared_size: 0,
          },
        ],
      }),
    ).toThrow();
    const sidecarId = stage(sidecar);
    expect(sidecarId).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      sql(`select status || ':' || (finished_at is not null)::text
        from public.clickup_asset_sidecars where id='${sidecarId}';`),
    ).toBe("completed:true");
  });

  it("preserva reply no mesmo tenant e na mesma tarefa", () => {
    expect(
      JSON.parse(
        sql(`select public.fn_apply_clickup_task_comment(
          '${GOV_ORG}','wk-assets','task-comment-1','${TASK}',null,'${HASH}',
          'user-1','Autor','Pai','2026-01-01T12:00:00Z',null)::text;`),
      ).result,
    ).toBe("created");
    expect(
      JSON.parse(
        sql(`select public.fn_apply_clickup_task_comment(
          '${GOV_ORG}','wk-assets','task-comment-2','${TASK}','task-comment-1','${SOURCE_HASH}',
          'user-2','Pessoa','Reply','2026-01-01T12:01:00Z',null)::text;`),
      ).result,
    ).toBe("created");
    expect(
      countAs(
        GOV_MANAGER,
        `select count(*) from public.crm_task_comments where task_id='${TASK}';`,
      ),
    ).toBe(2);
  });

  it("claim usa SKIP LOCKED/token CAS e cancel-after-claim impede promoção", () => {
    sql(`
      select set_config('deskcomm.clickup_transition','execute',false);
      update public.clickup_import_runs set status='queued' where id='${RUN}';
      select set_config('deskcomm.clickup_transition','claim',false);
      update public.clickup_import_runs set status='running',
        lease_owner='${WORKER_A}',lease_token='${CLAIM}',lease_expires_at=now()+interval '5 minutes',
        heartbeat_at=now() where id='${RUN}';
      insert into public.clickup_asset_sidecars
        (id,organization_id,run_id,workspace_id,snapshot_hash,sidecar_version,manifest_version,
         mode,coverage,checkpoint,status,created_by)
      values ('${SIDECAR}','${GOV_ORG}','${RUN}','wk-assets','${HASH}',1,3,'full','{}','{}','ready','${GOV_MANAGER}');
      insert into public.clickup_asset_uploads
        (id,organization_id,run_id,workspace_id,snapshot_hash,kind,attachment_id,sha256,
         declared_size,storage_path,state,created_by,expires_at)
      values ('${UPLOAD}','${GOV_ORG}','${RUN}','wk-assets','${HASH}','asset','asset-1','${SOURCE_HASH}',
        4,'quarantine/${GOV_ORG}/${RUN}/${HASH}/${UPLOAD}/${SOURCE_HASH}','uploaded','${GOV_MANAGER}',now()+interval '1 hour');
      insert into public.clickup_asset_items
        (id,organization_id,sidecar_id,run_id,workspace_id,attachment_id,parent_type,
         parent_external_id,file_name,declared_size,sniffed_mime,source_sha256,upload_id,status)
      values ('${ASSET}','${GOV_ORG}','${SIDECAR}','${RUN}','wk-assets','asset-1','task',
        'task-source','x.pdf',4,'application/pdf','${SOURCE_HASH}','${UPLOAD}','ready');
    `);
    expect(
      sql(`select coalesce((public.fn_claim_clickup_asset('${WORKER_A}',90)).id::text,'');`),
    ).toBe("");
    expect(sql(`select attempts::text from public.clickup_asset_items where id='${ASSET}';`)).toBe(
      "0",
    );
    sql(`insert into public.clickup_object_mappings
      (organization_id,connection_id,workspace_id,entity_type,external_id,source_hash,task_id,created_by)
      values ('${GOV_ORG}','${CONNECTION}','wk-assets','task','task-source','${HASH}','${TASK}','${GOV_MANAGER}');`);
    const claimed = sql(`select (public.fn_claim_clickup_asset('${WORKER_A}',90)).id::text;`);
    expect(claimed).toBe(ASSET);
    expect(
      sql(`select coalesce((public.fn_claim_clickup_asset('${WORKER_B}',90)).id::text,'');`),
    ).toBe("");
    expect(
      sql(`select public.fn_finish_clickup_asset('${GOV_ORG}','${ASSET}','${CLAIM}',
        'promoted',null,null,null,'x');`),
    ).toBe("f");
    const token = sql(
      `select claim_token::text from public.clickup_asset_items where id='${ASSET}';`,
    );
    sql(`select public.fn_cancel_clickup_import_run('${GOV_ORG}','${RUN}');`);
    expect(
      sql(`select public.fn_finish_clickup_asset('${GOV_ORG}','${ASSET}','${token}',
        'promoted',null,null,null,'${GOV_ORG}/${"d".repeat(32)}/tasks/${TASK}/${SOURCE_HASH}.pdf');`),
    ).toBe("f");
    expect(sql(`select status from public.clickup_asset_items where id='${ASSET}';`)).toBe(
      "cancelled",
    );
    expect(sql(`select status from public.clickup_asset_sidecars where id='${SIDECAR}';`)).toBe(
      "cancelled",
    );
    expect(
      sql(`select count(*) from public.crm_task_attachments where source_attachment_id='asset-1';`),
    ).toBe("0");
  });

  it("terminaliza sem hang quando pai ou comentário terminam sem aplicação", () => {
    const parentRun = "90970000-0000-4000-8000-000000000020";
    const commentRun = "90970000-0000-4000-8000-000000000021";
    const skippedRun = "90970000-0000-4000-8000-000000000028";
    const parentSidecar = "90970000-0000-4000-8000-000000000022";
    const commentSidecar = "90970000-0000-4000-8000-000000000023";
    const skippedSidecar = "90970000-0000-4000-8000-000000000029";
    const parentUpload = "90970000-0000-4000-8000-000000000024";
    const commentUpload = "90970000-0000-4000-8000-000000000025";
    const skippedUpload = "90970000-0000-4000-8000-000000000030";
    const parentAsset = "90970000-0000-4000-8000-000000000026";
    const commentAsset = "90970000-0000-4000-8000-000000000027";
    const skippedAsset = "90970000-0000-4000-8000-000000000031";
    sql(`
      insert into public.clickup_import_runs
        (id,organization_id,connection_id,workspace_id,source,scope,status,manifest_version,
         snapshot_hash,preview_revision,created_by)
      values
        ('${parentRun}','${GOV_ORG}','${CONNECTION}','wk-assets','bundle','crm','ready',3,'${HASH}',1,'${GOV_MANAGER}'),
        ('${commentRun}','${GOV_ORG}','${CONNECTION}','wk-assets','bundle','crm','ready',3,'${SOURCE_HASH}',1,'${GOV_MANAGER}'),
        ('${skippedRun}','${GOV_ORG}','${CONNECTION}','wk-assets','bundle','crm','ready',3,'${HASH}',1,'${GOV_MANAGER}');
      insert into public.clickup_import_items
        (organization_id,run_id,workspace_id,entity_type,external_id,parent_external_id,
         source_hash,source_metadata,content_access,execution_blocked,status)
      values
        ('${GOV_ORG}','${parentRun}','wk-assets','task','terminal-parent',null,
          '${HASH}','{}','none',false,'failed'),
        ('${GOV_ORG}','${commentRun}','wk-assets','task','comment-parent',null,
          '${HASH}','{}','none',false,'succeeded'),
        ('${GOV_ORG}','${commentRun}','wk-assets','comment','terminal-comment','comment-parent',
          '${SOURCE_HASH}','{}','none',false,'failed'),
        ('${GOV_ORG}','${skippedRun}','wk-assets','task','ignored-parent',null,
          '${HASH}','{}','none',false,'skipped');
      insert into public.clickup_object_mappings
        (organization_id,connection_id,workspace_id,entity_type,external_id,source_hash,task_id,created_by)
      values ('${GOV_ORG}','${CONNECTION}','wk-assets','task','comment-parent','${HASH}','${TASK}','${GOV_MANAGER}');
      insert into public.clickup_asset_sidecars
        (id,organization_id,run_id,workspace_id,snapshot_hash,sidecar_version,manifest_version,
         mode,coverage,checkpoint,status,created_by)
      values
        ('${parentSidecar}','${GOV_ORG}','${parentRun}','wk-assets','${HASH}',1,3,'full','{}','{}','ready','${GOV_MANAGER}'),
        ('${commentSidecar}','${GOV_ORG}','${commentRun}','wk-assets','${SOURCE_HASH}',1,3,'full','{}','{}','ready','${GOV_MANAGER}'),
        ('${skippedSidecar}','${GOV_ORG}','${skippedRun}','wk-assets','${HASH}',1,3,'full','{}','{}','ready','${GOV_MANAGER}');
      insert into public.clickup_asset_uploads
        (id,organization_id,run_id,workspace_id,snapshot_hash,kind,attachment_id,sha256,
         declared_size,storage_path,state,created_by,expires_at)
      values
        ('${parentUpload}','${GOV_ORG}','${parentRun}','wk-assets','${HASH}','asset','terminal-parent-asset','${HASH}',4,
          'quarantine/${GOV_ORG}/${parentRun}/${HASH}/${parentUpload}/${HASH}','uploaded','${GOV_MANAGER}',now()+interval '1 hour'),
        ('${commentUpload}','${GOV_ORG}','${commentRun}','wk-assets','${SOURCE_HASH}','asset','terminal-comment-asset','${SOURCE_HASH}',4,
          'quarantine/${GOV_ORG}/${commentRun}/${SOURCE_HASH}/${commentUpload}/${SOURCE_HASH}','uploaded','${GOV_MANAGER}',now()+interval '1 hour'),
        ('${skippedUpload}','${GOV_ORG}','${skippedRun}','wk-assets','${HASH}','asset','ignored-parent-asset','${HASH}',4,
          'quarantine/${GOV_ORG}/${skippedRun}/${HASH}/${skippedUpload}/${HASH}','uploaded','${GOV_MANAGER}',now()+interval '1 hour');
      insert into public.clickup_asset_items
        (id,organization_id,sidecar_id,run_id,workspace_id,attachment_id,parent_type,
         parent_external_id,comment_id,file_name,declared_size,sniffed_mime,source_sha256,upload_id,status)
      values
        ('${parentAsset}','${GOV_ORG}','${parentSidecar}','${parentRun}','wk-assets','terminal-parent-asset','task',
          'terminal-parent',null,'p.pdf',4,'application/pdf','${HASH}','${parentUpload}','ready'),
        ('${commentAsset}','${GOV_ORG}','${commentSidecar}','${commentRun}','wk-assets','terminal-comment-asset','task',
          'comment-parent','terminal-comment','c.pdf',4,'application/pdf','${SOURCE_HASH}','${commentUpload}','ready'),
        ('${skippedAsset}','${GOV_ORG}','${skippedSidecar}','${skippedRun}','wk-assets','ignored-parent-asset','task',
          'ignored-parent',null,'s.pdf',4,'application/pdf','${HASH}','${skippedUpload}','ready');
      select set_config('deskcomm.clickup_transition','execute',false);
      update public.clickup_import_runs set status='queued' where id in ('${parentRun}','${commentRun}','${skippedRun}');
      select set_config('deskcomm.clickup_transition','claim',false);
      update public.clickup_import_runs set status='running',lease_owner='${WORKER_A}',lease_token='${CLAIM}',
        lease_expires_at=now()+interval '5 minutes',heartbeat_at=now()
        where id in ('${parentRun}','${commentRun}','${skippedRun}');
    `);
    expect(
      sql(`select coalesce((public.fn_claim_clickup_asset('${WORKER_A}',90)).id::text,'');`),
    ).toBe("");
    expect(
      sql(`select string_agg(status||':'||error_code||':'||attempts::text,',' order by id)
        from public.clickup_asset_items where id in ('${parentAsset}','${commentAsset}');`),
    ).toBe("failed:blocked_parent_not_applied:0,failed:blocked_parent_not_applied:0");
    expect(
      sql(`select string_agg(status,',' order by id) from public.clickup_asset_sidecars
        where id in ('${parentSidecar}','${commentSidecar}');`),
    ).toBe("completed_with_errors,completed_with_errors");
    expect(
      sql(`select string_agg(status,',' order by id) from public.clickup_import_runs
        where id in ('${parentRun}','${commentRun}');`),
    ).toBe("completed_with_errors,completed_with_errors");
    expect(
      sql(`select status||':'||error_code||':'||attempts::text from public.clickup_asset_items
        where id='${skippedAsset}';`),
    ).toBe("skipped:skipped_parent_not_imported:0");
    expect(
      sql(`select status from public.clickup_asset_sidecars where id='${skippedSidecar}';`),
    ).toBe("completed");
    expect(sql(`select status from public.clickup_import_runs where id='${skippedRun}';`)).toBe(
      "completed",
    );
  });

  it("expurgo enfileira quarantine órfã", () => {
    const path = `quarantine/${GOV_ORG}/${RUN}/${HASH}/${UPLOAD_EXPIRED}/${SOURCE_HASH}`;
    const sidecarUpload = "90970000-0000-4000-8000-000000000013";
    const sidecarPath = `quarantine/${GOV_ORG}/${RUN}/${HASH}/${sidecarUpload}/${HASH}`;
    sql(`insert into public.clickup_asset_uploads
      (id,organization_id,run_id,workspace_id,snapshot_hash,kind,attachment_id,sha256,
       declared_size,storage_path,state,created_by,created_at,expires_at)
      values ('${UPLOAD_EXPIRED}','${GOV_ORG}','${RUN}','wk-assets','${HASH}','asset','expired-asset',
        '${SOURCE_HASH}',4,'${path}','uploaded','${GOV_MANAGER}',now()-interval '2 days',now()-interval '1 day'),
        ('${sidecarUpload}','${GOV_ORG}','${RUN}','wk-assets','${HASH}','sidecar',null,
        '${HASH}',4,'${sidecarPath}','uploaded','${GOV_MANAGER}',now()-interval '2 days',now()-interval '1 day');`);
    expect(Number(sql(`select public.fn_expurgar_clickup_asset_staging(10);`))).toBeGreaterThan(0);
    expect(
      sql(`select count(*) from public.storage_redaction_queue
        where bucket='clickup-assets' and object_path='${path}';`),
    ).toBe("1");
    expect(
      sql(`select count(*) from public.storage_redaction_queue
        where bucket='clickup-sidecars' and object_path='${sidecarPath}';`),
    ).toBe("1");
  });

  it("cleanup cobre quarantine consumed mesmo se o remove do Storage falhar", () => {
    const upload = "90970000-0000-4000-8000-000000000012";
    const path = `quarantine/${GOV_ORG}/${RUN}/${HASH}/${upload}/${SOURCE_HASH}`;
    sql(`insert into public.clickup_asset_uploads
      (id,organization_id,run_id,workspace_id,snapshot_hash,kind,attachment_id,sha256,
       declared_size,storage_path,state,created_by,expires_at)
      values ('${upload}','${GOV_ORG}','${RUN}','wk-assets','${HASH}','asset','cleanup-asset',
        '${SOURCE_HASH}',4,'${path}','consumed','${GOV_MANAGER}',now()+interval '1 hour');`);
    expect(
      sql(`select public.fn_queue_clickup_quarantine_cleanup('${GOV_ORG}','${upload}');`),
    ).toBe("t");
    expect(
      sql(`select count(*) from public.storage_redaction_queue
        where bucket='clickup-assets' and object_path='${path}' and status='pending';`),
    ).toBe("1");
  });

  it("enfileira blob final órfão e preserva hash ainda referenciado", () => {
    const orphan = `${GOV_ORG}/wk-assets/tasks/${TASK}/${"c".repeat(64)}.pdf`;
    const referenced = `${GOV_ORG}/wk-assets/tasks/${TASK}/${"d".repeat(64)}.pdf`;
    expect(sql(`select public.fn_queue_clickup_asset_orphan('${GOV_ORG}','${orphan}');`)).toBe("t");
    sql(`insert into public.crm_task_attachments
      (organization_id,task_id,workspace_id,source_attachment_id,source_sha256,
       file_name,file_size,mime_type,storage_path)
      values ('${GOV_ORG}','${TASK}','wk-assets','referenced-asset','${"d".repeat(64)}',
        'referenciado.pdf',4,'application/pdf','${referenced}');`);
    expect(sql(`select public.fn_queue_clickup_asset_orphan('${GOV_ORG}','${referenced}');`)).toBe(
      "f",
    );
    expect(
      sql(`select count(*) from public.storage_redaction_queue
        where bucket='clickup-assets' and object_path='${referenced}';`),
    ).toBe("0");
  });

  it("reconciliador recupera blob final perdido quando o enqueue síncrono falha", () => {
    const orphan = `${GOV_ORG}/${"e".repeat(32)}/tasks/${TASK}/${"f".repeat(64)}.pdf`;
    sql(`insert into storage.objects(bucket_id,name,created_at)
      values('clickup-assets','${orphan}',now()-interval '2 hours');`);
    expect(Number(sql(`select public.fn_reconcile_clickup_asset_orphans(10);`))).toBeGreaterThan(0);
    expect(
      sql(`select count(*) from public.storage_redaction_queue
        where bucket='clickup-assets' and object_path='${orphan}' and status='pending';`),
    ).toBe("1");
  });
});
