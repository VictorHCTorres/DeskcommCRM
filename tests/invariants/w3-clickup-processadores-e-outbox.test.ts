import { beforeAll, describe, expect, it } from "vitest";

import { GOV_MANAGER, GOV_ORG, seedGov, sql } from "./gov-helpers";

const SOURCE = "90960000-0000-4000-8000-000000000001";
const VERSION = "90960000-0000-4000-8000-000000000002";
const HASH = "c".repeat(64);

describe("W3.1/W3.2 — leases por processador e outbox de conhecimento", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into public.ai_knowledge_sources
        (id, organization_id, agent_id, source_type, name, status, is_active)
      values ('${SOURCE}', '${GOV_ORG}', null, 'documento', 'ClickUp importado', 'ready', true);
      insert into public.ai_knowledge_versions
        (id, organization_id, agent_id, knowledge_source_id, version_number, status, is_active)
      values ('${VERSION}', '${GOV_ORG}', null, '${SOURCE}', 1, 'ready', true);
      update public.ai_knowledge_sources set active_kb_version_id = '${VERSION}' where id = '${SOURCE}';
    `);
  });

  it("emite uma vez e preserva versão anterior pronta durante nova indexação", () => {
    const first = JSON.parse(
      sql(`select public.fn_emit_clickup_knowledge_update(
        '${GOV_ORG}', '${SOURCE}', '${HASH}', '{"origin":"clickup"}'::jsonb);`),
    );
    const replay = JSON.parse(
      sql(`select public.fn_emit_clickup_knowledge_update(
        '${GOV_ORG}', '${SOURCE}', '${HASH}', '{"origin":"clickup"}'::jsonb);`),
    );
    expect(first).toMatchObject({ emitted: true, replay: false });
    expect(replay).toEqual({ emitted: false, replay: true });
    expect(
      sql(`select status || ':' || last_index_status || ':' || active_kb_version_id
        from public.ai_knowledge_sources where id = '${SOURCE}';`),
    ).toBe(`ready:indexing_pending:${VERSION}`);
    expect(
      sql(`select count(*) from public.event_log where organization_id = '${GOV_ORG}'
        and event_type = 'knowledge_source.updated' and entity_id = '${SOURCE}';`),
    ).toBe("1");
  });

  it("não expõe RPC nem tabelas internas a authenticated", () => {
    expect(() =>
      sql(`set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_MANAGER}"}', false);
        select public.fn_emit_clickup_knowledge_update(
          '${GOV_ORG}', '${SOURCE}', '${"d".repeat(64)}', '{}'::jsonb);`),
    ).toThrow();
    expect(
      sql(`select count(*) from information_schema.role_table_grants
        where table_schema = 'public'
          and table_name in ('clickup_import_processor_leases','clickup_knowledge_update_receipts')
          and grantee in ('PUBLIC','anon','authenticated');`),
    ).toBe("0");
  });
});
