#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {};
const array = (value) => (Array.isArray(value) ? value : []);
const text = (value) =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(",")}}`;
};
const hash = (value) => createHash("sha256").update(canonical(value)).digest("hex");

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--backup") result.backup = argv[++index];
    else if (key === "--connection-id") result.connectionId = argv[++index];
    else if (key === "--workspace") result.workspaceId = argv[++index];
    else if (key === "--out") result.out = argv[++index];
    else throw new Error(`argumento_desconhecido:${key}`);
  }
  return result;
}

function safeAssignees(value) {
  return array(value).flatMap((raw) => {
    const email = text(record(raw).email).trim().toLowerCase();
    return email ? [{ email }] : [];
  });
}

function checklistItems(value) {
  return array(value).flatMap((rawChecklist) =>
    array(record(rawChecklist).items).map((rawItem) => {
      const item = record(rawItem);
      return { name: text(item.name), resolved: item.resolved === true };
    }),
  );
}

function taskMetadata(raw, listId) {
  const task = record(raw);
  const attachmentsExported = Object.prototype.hasOwnProperty.call(task, "attachments");
  const attachments = array(task.attachments);
  const status = record(task.status);
  return {
    list_id: listId,
    name: text(task.name),
    description: text(task.description ?? task.text_content),
    parent_id: text(task.parent) || null,
    status_id: text(status.id),
    status_name: text(status.status),
    status_type: text(status.type),
    date_created: text(task.date_created) || null,
    date_updated: text(task.date_updated) || null,
    date_closed: text(task.date_closed) || null,
    date_done: text(task.date_done) || null,
    due_date: text(task.due_date) || null,
    assignees: safeAssignees(task.assignees),
    checklists: checklistItems(task.checklists),
    custom_fields: array(task.custom_fields).map((rawField) => {
      const field = record(rawField);
      const options = array(record(field.type_config).options);
      const option =
        text(field.type) === "drop_down" && Number.isInteger(Number(field.value))
          ? record(options[Number(field.value)])
          : {};
      return { id: text(field.id), value: text(option.id) || (field.value ?? null) };
    }),
    attachment_count: attachmentsExported ? attachments.length : null,
    attachment_status: attachmentsExported
      ? attachments.length > 0
        ? "skipped_not_imported"
        : "none"
      : "unknown_not_exported",
  };
}

/** Converte o backup hidratado do harness em manifesto v3 consumível pela prévia CRM. */
export async function exportarClickUpCrmBundleV3(options) {
  if (!options.backup || !options.connectionId) throw new Error("backup_e_connection_obrigatorios");
  const backup = resolve(options.backup);
  const hierarchy = JSON.parse(await readFile(join(backup, "hierarquia.json"), "utf8"));
  const workspaceId = text(options.workspaceId ?? hierarchy.team);
  if (!workspaceId) throw new Error("workspace_obrigatorio");
  const objects = [
    {
      source_type: "workspace",
      source_id: workspaceId,
      metadata: { name: `Workspace ${workspaceId}` },
      content_access: "none",
    },
  ];
  const listIds = new Set();
  for (const rawSpace of array(hierarchy.spaces)) {
    const space = record(rawSpace);
    const spaceId = text(space.id);
    objects.push({
      source_type: "space",
      source_id: spaceId,
      parent_source_id: workspaceId,
      metadata: { name: text(space.name) },
      content_access: "none",
    });
    const folders = array(space.folders);
    const lists = [];
    for (const rawFolder of folders) {
      const folder = record(rawFolder);
      const folderId = text(folder.id);
      objects.push({
        source_type: "folder",
        source_id: folderId,
        parent_source_id: spaceId,
        metadata: { name: text(folder.name), space_id: spaceId },
        content_access: "none",
      });
      for (const rawList of array(folder.lists)) lists.push([record(rawList), folderId]);
    }
    for (const rawList of array(space.lists)) lists.push([record(rawList), null]);
    for (const [list, folderId] of lists) {
      const listId = text(list.id);
      listIds.add(listId);
      objects.push({
        source_type: "list",
        source_id: listId,
        parent_source_id: folderId ?? spaceId,
        metadata: {
          name: text(list.name),
          space_id: spaceId,
          space_name: text(space.name),
          folder_id: folderId,
          folder_name: folderId
            ? text(
                record(folders.find((candidate) => text(record(candidate).id) === folderId)).name,
              )
            : null,
        },
        content_access: "none",
      });
      for (const rawStatus of array(list.statuses)) {
        const status = record(rawStatus);
        const statusId = text(status.id);
        objects.push({
          source_type: "status",
          source_id: `${listId}:${statusId}`,
          parent_source_id: listId,
          metadata: {
            list_id: listId,
            source_status_id: statusId,
            name: text(status.status),
            type: text(status.type),
            orderindex: status.orderindex ?? null,
          },
          content_access: "none",
        });
      }
    }
  }

  for (const filename of (await readdir(join(backup, "campos"))).filter((name) =>
    name.endsWith(".json"),
  )) {
    const listId = basename(filename, ".json");
    if (!listIds.has(listId)) continue;
    const fields = array(
      JSON.parse(await readFile(join(backup, "campos", filename), "utf8")).fields,
    );
    for (const rawField of fields) {
      const field = record(rawField);
      const fieldId = text(field.id);
      objects.push({
        source_type: "custom_field",
        source_id: `${listId}:${fieldId}`,
        parent_source_id: listId,
        metadata: {
          list_id: listId,
          source_field_id: fieldId,
          name: text(field.name),
          type: text(field.type),
          type_config: record(field.type_config),
        },
        content_access: "none",
      });
    }
  }

  for (const filename of (await readdir(join(backup, "tasks"))).filter((name) =>
    name.endsWith(".jsonl"),
  )) {
    const listId = basename(filename, ".jsonl");
    if (!listIds.has(listId)) continue;
    const lines = (await readFile(join(backup, "tasks", filename), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean);
    for (const line of lines) {
      const task = JSON.parse(line);
      const taskId = text(task.id);
      const metadata = taskMetadata(task, listId);
      objects.push({
        source_type: "task",
        source_id: taskId,
        parent_source_id: metadata.parent_id ?? listId,
        source_revision: metadata.date_updated,
        metadata,
        content_access: "none",
      });
    }
  }

  const manifest = {
    connection_id: options.connectionId,
    workspace_id: workspaceId,
    source: "bundle",
    scope: "crm",
    manifest_version: 3,
    source_revision: hash(objects),
    objects,
  };
  if (options.out) {
    const out = resolve(options.out);
    const temporary = `${out}.${process.pid}.tmp`;
    await mkdir(dirname(out), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, out);
  }
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = args(process.argv.slice(2));
  await exportarClickUpCrmBundleV3(options);
}
