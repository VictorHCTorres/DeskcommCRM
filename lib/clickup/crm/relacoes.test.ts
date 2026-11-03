import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { applyClickUpCrmRelation } from "./relacoes";

describe("relações CRM importadas do ClickUp", () => {
  it("converge após crash/replay e recusa hash novo em create-only", async () => {
    let relation: Record<string, unknown> | null = null;
    const mappings = [
      { external_id: "a", lead_id: "lead-a", task_id: null },
      { external_id: "b", lead_id: null, task_id: "task-b" },
    ];
    const db = {
      from(table: string) {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          in() {
            return Promise.resolve({
              data:
                table === "clickup_object_mappings"
                  ? mappings
                  : [
                      { external_id: "a", status: "succeeded", result_kind: "created" },
                      { external_id: "b", status: "succeeded", result_kind: "created" },
                    ],
              error: null,
            });
          },
          maybeSingle() {
            return Promise.resolve({ data: relation, error: null });
          },
          insert(value: Record<string, unknown>) {
            relation = value;
            return Promise.resolve({ error: null });
          },
        };
        if (table === "clickup_object_mappings") return query;
        return query;
      },
    } as unknown as SupabaseClient;
    const run = { organization_id: "org", workspace_id: "wk", id: "run" };
    const item = {
      external_id: "linked:a:b",
      source_hash: "a".repeat(64),
      source_metadata: {
        relation_type: "linked",
        source_task_id: "a",
        target_task_id: "b",
      },
    };
    await expect(applyClickUpCrmRelation(db, run, item)).resolves.toBe("succeeded");
    await expect(applyClickUpCrmRelation(db, run, item)).resolves.toBe("unchanged");
    await expect(
      applyClickUpCrmRelation(db, run, { ...item, source_hash: "b".repeat(64) }),
    ).rejects.toThrow("clickup_create_only_source_changed");
    expect(relation).toMatchObject({
      left_lead_id: "lead-a",
      right_task_id: "task-b",
      source_external_id: "a",
      target_external_id: "b",
    });
  });

  it("libera como skipped quando um endpoint foi ignorado explicitamente", async () => {
    const db = {
      from(table: string) {
        const query = {
          select() {
            return query;
          },
          eq() {
            return query;
          },
          in() {
            return Promise.resolve(
              table === "clickup_object_mappings"
                ? { data: [], error: null }
                : {
                    data: [{ external_id: "a", status: "skipped", result_kind: "skipped" }],
                    error: null,
                  },
            );
          },
        };
        return query;
      },
    } as unknown as SupabaseClient;
    await expect(
      applyClickUpCrmRelation(
        db,
        { organization_id: "org", workspace_id: "wk", id: "run" },
        {
          source_hash: "a".repeat(64),
          source_metadata: {
            relation_type: "linked",
            source_task_id: "a",
            target_task_id: "b",
          },
        },
      ),
    ).resolves.toBe("skipped");
  });

  it("materializa a relação após crash quando os pais foram receipts unchanged", async () => {
    let inserted = false;
    const db = {
      from(table: string) {
        const query = {
          select() { return query; },
          eq() { return query; },
          in() {
            return Promise.resolve({
              data: table === "clickup_import_items"
                ? [
                    { external_id: "a", status: "skipped", result_kind: "unchanged" },
                    { external_id: "b", status: "skipped", result_kind: "unchanged" },
                  ]
                : [
                    { external_id: "a", lead_id: "lead-a", task_id: null },
                    { external_id: "b", lead_id: null, task_id: "task-b" },
                  ],
              error: null,
            });
          },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
          insert() { inserted = true; return Promise.resolve({ error: null }); },
        };
        return query;
      },
    } as unknown as SupabaseClient;
    await expect(applyClickUpCrmRelation(db, { organization_id: "org", workspace_id: "wk", id: "run" }, {
      external_id: "linked:a:b",
      source_hash: "a".repeat(64),
      source_metadata: { relation_type: "linked", source_task_id: "a", target_task_id: "b" },
    })).resolves.toBe("succeeded");
    expect(inserted).toBe(true);
  });
});
