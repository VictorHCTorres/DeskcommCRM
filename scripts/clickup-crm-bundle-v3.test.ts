import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { exportarClickUpCrmBundleV3 } from "./clickup-crm-bundle-v3.mjs";

describe("bundle ClickUp CRM v3", () => {
  it("preserva bindings por List, folderless, datas reais e não persiste URL de anexo", async () => {
    const root = await mkdtemp(join(tmpdir(), "clickup-crm-"));
    await mkdir(join(root, "tasks"));
    await mkdir(join(root, "campos"));
    await writeFile(
      join(root, "hierarquia.json"),
      JSON.stringify({
        team: "w1",
        coverage: { archive_scope: "active_and_archived", include_timl: true },
        spaces: [
          {
            id: "s1",
            name: "Área",
            folders: [],
            lists: [
              {
                id: "l1",
                name: "Funil",
                statuses: [{ id: "shared", status: "Feito", type: "done" }],
              },
            ],
          },
        ],
      }),
    );
    await writeFile(
      join(root, "campos/l1.json"),
      JSON.stringify({ fields: [{ id: "f1", name: "Data", type: "date", type_config: {} }] }),
    );
    await writeFile(
      join(root, "tasks/l1.jsonl"),
      `${JSON.stringify({ id: "t1", name: "Negócio", status: { id: "shared", type: "done" }, date_done: "1730619000000", due_date: "1730619000000", start_date: "1710052200000", time_estimate: 0, priority: { priority: "normal" }, tags: [{ name: "VIP", tag_bg: "#fff" }], watchers: [{ id: 42, email: "nao-persistir@example.com" }], linked_tasks: [{ task_id: "t1", link_id: "t2", date_created: "1730619000000" }], checklists: [{ id: "c-empty", name: "Vazio", resolved: 0, unresolved: 0, items: [] }], status: { id: "shared", type: "done" }, parent: null, attachments: [{ url: "https://signed.example/secret" }], custom_fields: [{ id: "f-dropdown", type: "drop_down", value: 0, type_config: { options: [{ id: "option-stable", name: "Primeira" }] } }] })}\n${JSON.stringify({ id: "t2", name: "Backup sem chave attachments", status: { id: "shared" }, parent: null, custom_fields: [], linked_tasks: [{ task_id: "t1", link_id: "t2", date_created: "1730619000000" }] })}\n`,
    );
    const manifest = await exportarClickUpCrmBundleV3({
      backup: root,
      connectionId: "00000000-0000-4000-8000-000000000001",
      out: join(root, "nova", "pasta", "manifest.json"),
    });
    expect(manifest.objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_type: "list", source_id: "l1", parent_source_id: "s1" }),
        expect.objectContaining({
          source_type: "status",
          source_id: "l1:shared",
          metadata: expect.objectContaining({ source_status_id: "shared" }),
        }),
        expect.objectContaining({
          source_type: "task",
          source_id: "t2",
          metadata: expect.objectContaining({
            attachment_count: null,
            attachment_status: "unknown_not_exported",
          }),
        }),
        expect.objectContaining({
          source_type: "custom_field",
          source_id: "l1:f1",
          metadata: expect.objectContaining({ source_field_id: "f1" }),
        }),
        expect.objectContaining({
          source_type: "task",
          source_id: "t1",
          metadata: expect.objectContaining({
            date_done: "1730619000000",
            priority: "normal",
            tags: [{ name: "VIP", color: "#fff" }],
            start_date: "1710052200000",
            time_estimate: 0,
            watcher_ids: ["42"],
            watcher_count: 1,
            archive_scope: "active_and_archived",
            attachment_status: "skipped_not_imported",
            custom_fields: [{ id: "f-dropdown", value: "option-stable" }],
          }),
        }),
      ]),
    );
    expect(manifest.objects.filter((object) => object.source_type === "task_relation")).toEqual([
      expect.objectContaining({
        source_id: "linked:t1:t2",
        metadata: expect.objectContaining({
          source_task_id: "t1",
          target_task_id: "t2",
          provenance: expect.objectContaining({ raw_occurrences: 2 }),
        }),
      }),
    ]);
    expect(JSON.stringify(manifest)).not.toContain("signed.example");
    expect(JSON.stringify(manifest)).not.toContain("nao-persistir@example.com");
  });
});
