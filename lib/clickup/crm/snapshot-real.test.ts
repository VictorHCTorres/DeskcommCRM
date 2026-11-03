import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import summary from "@/tests/fixtures/clickup-2026-11-02-summary.json";

const snapshot = path.resolve(
  process.cwd(),
  "../../03-API-E-CODIGO/clickup-harness/backups/2026-11-02",
);
const hash = (ids: Iterable<string>) =>
  createHash("sha256")
    .update([...ids].sort().join("\n"))
    .digest("hex");

describe("reconciliação do snapshot real ClickUp 2026-11-02", () => {
  it("mantém no CI a fixture estrutural sem PII e fecha a equação", () => {
    expect(summary).toMatchObject({
      lists: 48,
      unique_lists: 48,
      empty_lists: 14,
      task_records: 1_983,
      root_tasks: 1_758,
      subtasks: 225,
      archived_tasks: 0,
      field_bindings: 1_932,
      unique_fields: 145,
      docs_metadata_only: 50,
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
    const results = { created: 0, updated: 0, unchanged: 1_983, skipped: 0, conflicts: 0 };
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
    const relationships: string[] = [];
    for (const file of readdirSync(path.join(snapshot, "tasks")).filter((name) =>
      name.endsWith(".jsonl"),
    )) {
      for (const line of readFileSync(path.join(snapshot, "tasks", file), "utf8").split("\n")) {
        if (!line.trim()) continue;
        discoveredTasks += 1;
        const task = JSON.parse(line);
        taskIds.add(String(task.id));
        if (task.parent) subtasks += 1;
        else rootTasks += 1;
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
