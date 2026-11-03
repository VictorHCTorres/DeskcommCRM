import { describe, expect, it } from "vitest";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  applyClickUpCrmItem,
  clickupDeterministicId,
  convertClickUpFieldValue,
  loadClickUpMemberDirectory,
  normalizeClickUpDueDate,
  resolveClickUpTaskAncestry,
} from "./aplicar";

describe("aplicação CRM do ClickUp", () => {
  it("mantém identidade por external id, sem depender de nome ou rename", () => {
    const beforeRename = clickupDeterministicId("org", "clickup-pipeline", "pipeline-key-1");
    const afterRename = clickupDeterministicId("org", "clickup-pipeline", "pipeline-key-1");
    expect(afterRename).toBe(beforeRename);
    expect(beforeRename).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("liga neta à task-pai e ao lead da task raiz", async () => {
    const parents = new Map([
      ["subtask-pai", "task-raiz"],
      ["task-raiz", "list-1"],
    ]);
    await expect(
      resolveClickUpTaskAncestry("subtask-pai", "list-1", async (id) => parents.get(id)),
    ).resolves.toEqual({
      ancestorExternalId: "task-raiz",
      parentTaskExternalId: "subtask-pai",
    });
    await expect(
      resolveClickUpTaskAncestry("task-raiz", "list-1", async (id) => parents.get(id)),
    ).resolves.toEqual({ ancestorExternalId: "task-raiz", parentTaskExternalId: null });
  });

  it("dry-run valida sem escrever domínio e nunca declara created", async () => {
    const db = {
      from() {
        throw new Error("dry_run_não_deveria_tocar_banco");
      },
    } as unknown as SupabaseClient;
    await expect(
      applyClickUpCrmItem(
        db,
        {
          dry_run: true,
          mapping_config: {
            crm: {
              lists: [{ list_id: "list-1", mode: "ignore" }],
            },
          },
        },
        { entity_type: "task", external_id: "task-1", source_metadata: { list_id: "list-1" } },
      ),
    ).resolves.toBe("validated");
  });

  it("converte tipos suportados e recusa valores inválidos", () => {
    expect(convertClickUpFieldValue("number", "12.5")).toBe(12.5);
    expect(convertClickUpFieldValue("checkbox", "false")).toBe(false);
    expect(convertClickUpFieldValue("labels", "vip")).toEqual(["vip"]);
    expect(convertClickUpFieldValue("user", { email: "a@example.com" })).toBe("a@example.com");
    expect(convertClickUpFieldValue("dropdown", { id: "opt-1", name: "Opção" })).toBe("opt-1");
    expect(() => convertClickUpFieldValue("number", "doze")).toThrow(
      "clickup_custom_field_invalid_number",
    );
    expect(() => convertClickUpFieldValue("date", "ontem-talvez")).toThrow(
      "clickup_custom_field_invalid_date",
    );
    expect(normalizeClickUpDueDate("1710052200000")).toBe("2024-03-10T06:30:00.000Z");
    expect(normalizeClickUpDueDate("2024-11-03T01:30:00-04:00")).toBe("2024-11-03T05:30:00.000Z");
  });

  it("se recupera de crash antes do receipt sem duplicar domínio", async () => {
    const rows = new Map<string, Set<string>>();
    const values = new Map<string, Array<Record<string, unknown>>>();
    let failReceipt = true;
    const db = {
      from(table: string) {
        const query = {
          async upsert(value: Record<string, unknown>) {
            if (table === "clickup_object_mappings" && failReceipt) {
              failReceipt = false;
              return { error: { message: "fault_injection_after_domain" } };
            }
            const ids = rows.get(table) ?? new Set<string>();
            ids.add(String(value.id ?? `${value.entity_type}:${value.external_id}`));
            rows.set(table, ids);
            values.set(table, [...(values.get(table) ?? []), value]);
            return { error: null };
          },
          select() {
            return query;
          },
          eq() {
            return query;
          },
          async maybeSingle() {
            return { data: null, error: null };
          },
        };
        return query;
      },
    } as unknown as SupabaseClient;
    const run = {
      id: "run-1",
      organization_id: "org-1",
      connection_id: "connection-1",
      workspace_id: "workspace-1",
      mapping_revision: 1,
      dry_run: false,
      mapping_config: {
        crm: {
          lists: [
            {
              list_id: "list-1",
              space_id: "space-1",
              folder_id: "folder-1",
              pipeline_key: "pipeline-1",
              mode: "crm_leads",
              area_name: "Área",
              group_name: "Grupo",
              pipeline_name: "Funil",
              statuses: [{ status_id: "open", name: "Aberto", terminal: "open" }],
              fields: [
                {
                  field_id: "dropdown-1",
                  label: "Origem",
                  source_type: "drop_down",
                  action: "native",
                  target_type: "dropdown",
                  options: [
                    { id: "opt-1", label: "Indicação" },
                    { id: "opt-2", label: "Anúncio" },
                  ],
                },
              ],
            },
          ],
        },
      },
    };
    const item = { entity_type: "list", external_id: "list-1", source_hash: "a".repeat(64) };
    await expect(applyClickUpCrmItem(db, run, item)).rejects.toThrow("fault_injection");
    await expect(applyClickUpCrmItem(db, run, item)).resolves.toBe("succeeded");
    await expect(
      applyClickUpCrmItem(db, run, {
        entity_type: "status",
        external_id: "list-1:open",
        source_hash: "b".repeat(64),
        source_metadata: { list_id: "list-1", source_status_id: "open" },
      }),
    ).resolves.toBe("succeeded");
    expect(rows.get("crm_pipeline_groups")?.size).toBe(2);
    expect(rows.get("crm_pipelines")?.size).toBe(1);
    expect(rows.get("crm_stages")?.size).toBe(1);
    expect(rows.get("clickup_object_mappings")?.size).toBe(4);
    expect((values.get("crm_pipelines")?.[0]?.settings as { fields: unknown[] }).fields).toEqual([
      expect.objectContaining({
        type: "select",
        options: [
          { value: "opt-1", label: "Indicação" },
          { value: "opt-2", label: "Anúncio" },
        ],
      }),
    ]);
    expect(rows.has("event_log")).toBe(false);
    expect(rows.has("capi_events")).toBe(false);
    expect(rows.has("automation_runs")).toBe(false);
  });

  it("carrega o diretório de membros uma vez por tenant no lote", async () => {
    let authLoads = 0;
    const query = {
      select() {
        return query;
      },
      eq() {
        return query;
      },
      is() {
        return query;
      },
      async not() {
        return { data: [{ user_id: "user-1" }], error: null };
      },
    };
    const db = {
      from() {
        return query;
      },
      auth: {
        admin: {
          async listUsers() {
            authLoads += 1;
            return {
              data: { users: [{ id: "user-1", email: "membro@example.com" }] },
              error: null,
            };
          },
        },
      },
    } as unknown as SupabaseClient;
    const first = await loadClickUpMemberDirectory(db, "org-cache");
    const second = await loadClickUpMemberDirectory(db, "org-cache");
    expect(first.get("membro@example.com")).toBe("user-1");
    expect(second).toBe(first);
    expect(authLoads).toBe(1);
  });
});
