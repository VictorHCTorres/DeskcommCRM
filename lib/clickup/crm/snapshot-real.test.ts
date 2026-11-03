import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import summary from "@/tests/fixtures/clickup-2026-11-02-summary.json";
import { clickupManifestSchema } from "@/lib/clickup/contrato";
import { exportarClickUpCrmBundleV3 } from "../../../scripts/clickup-crm-bundle-v3.mjs";

const snapshot = path.resolve("/Volumes/ProjectSSD/clickup-harness-backups/2026-11-03");
const hash = (ids: Iterable<string>) =>
  createHash("sha256")
    .update([...ids].sort().join("\n"))
    .digest("hex");

describe("reconciliação do snapshot real ClickUp 2026-11-02", () => {
  it.skipIf(!existsSync(snapshot))(
    "o bundle completo de 5.813 objetos cabe no schema e no guard de 20 MiB",
    async () => {
      const manifest = await exportarClickUpCrmBundleV3({
        backup: snapshot,
        connectionId: "00000000-0000-4000-8000-000000000001",
      });
      expect(manifest.objects).toHaveLength(5_813);
      expect(clickupManifestSchema.safeParse(manifest).success).toBe(true);
      expect(Buffer.byteLength(JSON.stringify(manifest), "utf8")).toBeLessThanOrEqual(
        20 * 1024 * 1024,
      );
    },
  );
  it("mantém no CI a fixture estrutural sem PII e fecha a equação", () => {
    expect(summary).toMatchObject({
      archive_scope: "active_and_archived",
      include_timl: true,
      tasks_with_backup_provenance: 2_096,
      lists: 76,
      unique_lists: 76,
      empty_lists: 29,
      task_records: 2_096,
      root_tasks: 1_871,
      subtasks: 225,
      archived_tasks: 0,
      field_bindings: 3_149,
      unique_fields: 166,
      docs_metadata_only: 50,
      prioritized_tasks: 306,
      tagged_tasks: 609,
      tag_occurrences: 731,
      unique_tags: 29,
      start_dates: 49,
      time_estimates_nonnull: 82,
      time_estimates_positive: 81,
      linked_tasks_raw: 28,
      canonical_relations: 14,
      checklist_groups: 4,
      checklist_items: 15,
    });
    const {
      fixture_structure_sha256: expectedStructure,
      snapshot_relationships_sha256: _,
      source: __,
      ...structure
    } = summary;
    expect(createHash("sha256").update(JSON.stringify(structure)).digest("hex")).toBe(
      expectedStructure,
    );
    const results = { created: 0, updated: 0, unchanged: 2_096, skipped: 0, conflicts: 0 };
    expect(summary.task_records).toBe(
      results.created + results.updated + results.unchanged + results.skipped + results.conflicts,
    );
  });

  it.skipIf(!existsSync(snapshot))("preserva identidades e fecha a equação de resultados", () => {
    const hierarchy = JSON.parse(readFileSync(path.join(snapshot, "hierarquia.json"), "utf8"));
    const listIds: string[] = [];
    for (const space of hierarchy.spaces ?? []) {
      for (const list of space.lists ?? []) listIds.push(String(list.id));
      for (const folder of space.folders ?? []) {
        for (const list of folder.lists ?? []) listIds.push(String(list.id));
      }
    }
    const taskIds = new Set<string>();
    let discoveredTasks = 0;
    let rootTasks = 0;
    let subtasks = 0;
    let prioritizedTasks = 0;
    let taggedTasks = 0;
    let tagOccurrences = 0;
    let startDates = 0;
    let timeEstimates = 0;
    let positiveTimeEstimates = 0;
    let linkedTasksRaw = 0;
    let checklistGroups = 0;
    let checklistItems = 0;
    let tasksWithBackupProvenance = 0;
    const tagDictionary: string[] = [];
    const canonicalRelations: string[] = [];
    const relationships: string[] = [];
    for (const file of readdirSync(path.join(snapshot, "tasks")).filter((name) =>
      name.endsWith(".jsonl"),
    )) {
      for (const line of readFileSync(path.join(snapshot, "tasks", file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        discoveredTasks += 1;
        const task = JSON.parse(line);
        if (
          task.backup_provenance?.archive_scope === "active_and_archived" &&
          task.backup_provenance?.include_timl === true
        ) {
          tasksWithBackupProvenance += 1;
        }
        taskIds.add(String(task.id));
        if (task.parent) subtasks += 1;
        else rootTasks += 1;
        if (task.priority?.priority) prioritizedTasks += 1;
        if (task.tags?.length) taggedTasks += 1;
        tagOccurrences += task.tags?.length ?? 0;
        for (const tag of task.tags ?? []) {
          tagDictionary.push(`${tag.name}\u0000${tag.tag_bg ?? tag.tag_fg ?? ""}`);
        }
        if (task.start_date != null) startDates += 1;
        if (task.time_estimate != null) {
          timeEstimates += 1;
          if (Number(task.time_estimate) > 0) positiveTimeEstimates += 1;
        }
        linkedTasksRaw += task.linked_tasks?.length ?? 0;
        for (const link of task.linked_tasks ?? []) {
          const [left, right] = [String(link.task_id), String(link.link_id)].sort();
          canonicalRelations.push(`linked:${left}:${right}`);
        }
        checklistGroups += task.checklists?.length ?? 0;
        checklistItems += (task.checklists ?? []).reduce(
          (total: number, checklist: { items?: unknown[] }) =>
            total + (checklist.items?.length ?? 0),
          0,
        );
        const parent = task.parent
          ? String(typeof task.parent === "object" ? task.parent.id : task.parent)
          : "";
        relationships.push(
          `task:${task.id}:${parent}:${task.list?.id ?? ""}:${task.archived === true}`,
        );
      }
    }
    expect(listIds).toHaveLength(summary.lists);
    expect(new Set(listIds).size).toBe(summary.unique_lists);
    expect(discoveredTasks).toBe(summary.task_records);
    expect(rootTasks).toBe(summary.root_tasks);
    expect(subtasks).toBe(summary.subtasks);
    expect(taskIds.size).toBe(summary.unique_tasks);
    expect(tasksWithBackupProvenance).toBe(summary.tasks_with_backup_provenance);
    expect(prioritizedTasks).toBe(summary.prioritized_tasks);
    expect(taggedTasks).toBe(summary.tagged_tasks);
    expect(tagOccurrences).toBe(summary.tag_occurrences);
    expect(new Set(tagDictionary.map((tag) => tag.split("\u0000")[0])).size).toBe(
      summary.unique_tags,
    );
    expect(startDates).toBe(summary.start_dates);
    expect(timeEstimates).toBe(summary.time_estimates_nonnull);
    expect(positiveTimeEstimates).toBe(summary.time_estimates_positive);
    expect(linkedTasksRaw).toBe(summary.linked_tasks_raw);
    expect(new Set(canonicalRelations).size).toBe(summary.canonical_relations);
    expect(checklistGroups).toBe(summary.checklist_groups);
    expect(checklistItems).toBe(summary.checklist_items);
    expect(hash(new Set(tagDictionary))).toBe(summary.tag_dictionary_sha256);
    expect(hash(new Set(canonicalRelations))).toBe(summary.canonical_relations_sha256);
    expect(hash(listIds)).toBe(summary.list_ids_sha256);
    expect(hash(taskIds)).toBe(summary.task_ids_sha256);
    const fieldIds = new Set<string>();
    let fieldDefinitions = 0;
    for (const file of readdirSync(path.join(snapshot, "campos")).filter((name) =>
      name.endsWith(".json"),
    )) {
      const document = JSON.parse(readFileSync(path.join(snapshot, "campos", file), "utf8"));
      for (const field of document.fields ?? document) {
        fieldDefinitions += 1;
        fieldIds.add(String(field.id));
        relationships.push(`field:${file.replace(".json", "")}:${field.id}:${field.type}`);
      }
    }
    expect(fieldDefinitions).toBe(summary.field_definitions);
    expect(fieldIds.size).toBe(summary.unique_fields);
    expect(hash(fieldIds)).toBe(summary.field_ids_sha256);
    const docsDocument = JSON.parse(readFileSync(path.join(snapshot, "docs.json"), "utf8"));
    const docs = Array.isArray(docsDocument)
      ? docsDocument
      : (docsDocument.docs ?? docsDocument.items ?? []);
    for (const doc of docs) {
      relationships.push(`doc:${doc.id}:${doc.visibility ?? doc.permission_level ?? ""}`);
    }
    expect(hash(relationships)).toBe(summary.snapshot_relationships_sha256);

    const result = { created: 0, updated: 0, unchanged: taskIds.size, skipped: 0, conflicts: 0 };
    expect(discoveredTasks).toBe(
      result.created + result.updated + result.unchanged + result.skipped + result.conflicts,
    );
  });
});
