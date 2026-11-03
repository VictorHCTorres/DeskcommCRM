import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_MANAGER,
  GOV_ORG,
  GOV_PIPELINE,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const OUTRA_ORG = "90260000-0000-4000-8000-000000000002";
const AREA = "90260000-0000-4000-8000-000000000010";
const GRUPO = "90260000-0000-4000-8000-000000000011";
const AREA_OUTRA = "90260000-0000-4000-8000-000000000012";

describe("hierarquia Área > Grupo > Funil", () => {
  beforeAll(() => {
    seedGov();
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${OUTRA_ORG}', 'hierarquia-outra', 'Outra organização', 'Outra organização')
        on conflict do nothing;
      insert into public.crm_pipeline_groups (id, organization_id, name, kind, position)
        values ('${AREA}', '${GOV_ORG}', 'Comercial 9026', 'area', 1000)
        on conflict do nothing;
      insert into public.crm_pipeline_groups (id, organization_id, name, kind, parent_id, position)
        values ('${GRUPO}', '${GOV_ORG}', 'Prospecção 9026', 'grupo', '${AREA}', 1000)
        on conflict do nothing;
      insert into public.crm_pipeline_groups (id, organization_id, name, kind, position)
        values ('${AREA_OUTRA}', '${OUTRA_ORG}', 'Área externa 9026', 'area', 1000)
        on conflict do nothing;
    `);
  });

  it("recusa Grupo sem Área", () => {
    expect(() =>
      sql(`insert into public.crm_pipeline_groups
        (organization_id, name, kind, position)
        values ('${GOV_ORG}', 'Órfão 9026', 'grupo', 2000);`),
    ).toThrow();
  });

  it("recusa pai de outra organização", () => {
    expect(() =>
      sql(`insert into public.crm_pipeline_groups
        (organization_id, name, kind, parent_id, position)
        values ('${GOV_ORG}', 'Vazamento 9026', 'grupo', '${AREA_OUTRA}', 2000);`),
    ).toThrow();
  });

  it("recusa funil ligado a Grupo de outra organização", () => {
    const grupoExterno = "90260000-0000-4000-8000-000000000013";
    sql(`insert into public.crm_pipeline_groups
      (id, organization_id, name, kind, parent_id, position)
      values ('${grupoExterno}', '${OUTRA_ORG}', 'Grupo externo 9026', 'grupo', '${AREA_OUTRA}', 1000)
      on conflict do nothing;`);
    expect(() =>
      sql(
        `update public.crm_pipelines set group_id = '${grupoExterno}' where id = '${GOV_PIPELINE}';`,
      ),
    ).toThrow();
  });

  it("não deixa membro ler Áreas ou Grupos de outra organização", () => {
    expect(
      countAs(
        GOV_VIEWER,
        `select count(*) from public.crm_pipeline_groups where id in ('${AREA}', '${AREA_OUTRA}');`,
      ),
    ).toBe(1);
  });

  it("fecha DELETE/TRUNCATE e concede somente leitura e escrita necessárias", () => {
    expect(
      sql(`select string_agg(grantee || ':' || privilege_type, ',' order by grantee, privilege_type)
        from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'crm_pipeline_groups'
          and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role');`),
    ).toBe(
      "authenticated:INSERT,authenticated:SELECT,authenticated:UPDATE,service_role:INSERT,service_role:SELECT,service_role:UPDATE",
    );
    expect(
      sql(`select string_agg(policyname || ':' || cmd || ':' || permissive, ',' order by policyname)
        from pg_policies
        where schemaname = 'public' and tablename = 'crm_pipeline_groups'
          and cmd in ('ALL', 'DELETE', 'INSERT', 'SELECT', 'UPDATE');`),
    ).toBe(
      "crm_pipeline_groups_manager_insert:INSERT:PERMISSIVE,crm_pipeline_groups_manager_update:UPDATE:PERMISSIVE,crm_pipeline_groups_select:SELECT:PERMISSIVE,support_write_delete:DELETE:RESTRICTIVE,support_write_insert:INSERT:RESTRICTIVE,support_write_update:UPDATE:RESTRICTIVE",
    );
    expect(
      sql(`select count(*) from pg_policies
        where schemaname = 'public' and tablename = 'crm_pipeline_groups'
          and permissive = 'PERMISSIVE' and cmd in ('ALL', 'DELETE');`),
    ).toBe("0");
  });

  it("viewer não escreve e manager escreve na própria organização", () => {
    expect(
      writeCountAs(
        GOV_VIEWER,
        `insert into public.crm_pipeline_groups
          (organization_id, name, kind, position)
         values ('${GOV_ORG}', 'Viewer 9026', 'area', 3000)`,
      ),
    ).toBe(0);
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.crm_pipeline_groups
          (organization_id, name, kind, position)
         values ('${GOV_ORG}', 'Manager 9026', 'area', 4000)`,
      ),
    ).toBe(1);
  });

  it("arquivar Grupo preserva o vínculo e o funil", () => {
    sql(`
      update public.crm_pipelines set group_id = '${GRUPO}' where id = '${GOV_PIPELINE}';
      update public.crm_pipeline_groups set archived_at = now() where id = '${GRUPO}';
    `);
    expect(
      sql(
        `select count(*) from public.crm_pipelines where id = '${GOV_PIPELINE}' and group_id = '${GRUPO}';`,
      ),
    ).toBe("1");
  });
});
