import { z } from "zod";

import type { ClickUpDiscoveredObject } from "@/lib/clickup/contrato";

const idSchema = z.union([z.string(), z.number()]).transform(String);
const unknownRecord = z.record(z.string(), z.unknown());
const listSchema = z
  .object({
    id: idSchema,
    name: z.string(),
    statuses: z.array(unknownRecord).default([]),
  })
  .passthrough();
const folderSchema = z
  .object({ id: idSchema, name: z.string(), lists: z.array(listSchema).default([]) })
  .passthrough();
export const CLICKUP_DISCOVERY_CONCURRENCY = 4;
/** Menor que a reserva idempotente de 15 min: nenhuma discovery pode sobreviver à reserva. */
export const CLICKUP_DISCOVERY_DEADLINE_MS = 12 * 60 * 1000;
/** Um `Retry-After` remoto não pode transformar a rota síncrona em job sem lease. */
export const CLICKUP_MAX_RETRY_AFTER_MS = 5_000;

async function getJson(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  sleep: (ms: number) => Promise<void>,
  deadlineAt: number,
  now: () => number,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const remainingBeforeFetch = deadlineAt - now();
    if (remainingBeforeFetch <= 0) throw new Error("clickup_discovery_deadline_exceeded");
    const response = await fetchImpl(`https://api.clickup.com/api/v2${path}`, {
      headers: { Authorization: token, Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, remainingBeforeFetch))),
    });
    if (now() >= deadlineAt) throw new Error("clickup_discovery_deadline_exceeded");
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retryAfter = Number(response.headers.get("retry-after") ?? 0);
      const requestedDelay = retryAfter > 0 ? retryAfter * 1_000 : 250 * 2 ** attempt;
      const remainingBeforeSleep = deadlineAt - now();
      if (remainingBeforeSleep <= 0) throw new Error("clickup_discovery_deadline_exceeded");
      await sleep(Math.min(requestedDelay, CLICKUP_MAX_RETRY_AFTER_MS, remainingBeforeSleep));
      continue;
    }
    throw new Error(`clickup_api_http_${response.status}`);
  }
  throw new Error("clickup_api_retry_exhausted");
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

function safeTaskMetadata(raw: Record<string, unknown>, listId: string) {
  const status = record(raw.status);
  const attachmentsExported = Object.prototype.hasOwnProperty.call(raw, "attachments");
  const attachments = array(raw.attachments);
  return {
    list_id: listId,
    name: text(raw.name),
    description: text(raw.description ?? raw.text_content),
    parent_id: text(raw.parent) || null,
    status_id: text(status.id),
    status_name: text(status.status),
    status_type: text(status.type),
    date_created: text(raw.date_created) || null,
    date_updated: text(raw.date_updated) || null,
    date_closed: text(raw.date_closed) || null,
    date_done: text(raw.date_done) || null,
    due_date: text(raw.due_date) || null,
    assignees: array(raw.assignees).flatMap((candidate) => {
      const email = text(record(candidate).email).trim().toLowerCase();
      return email ? [{ email }] : [];
    }),
    checklists: array(raw.checklists).flatMap((checklist) =>
      array(record(checklist).items).map((candidate) => ({
        name: text(record(candidate).name),
        resolved: record(candidate).resolved === true,
      })),
    ),
    custom_fields: array(raw.custom_fields).map((candidate) => {
      const field = record(candidate);
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

/** Descoberta CRM completa da API v2; os IDs de binding incluem a List para não colidirem. */
export async function discoverClickUpCrmApi(input: {
  workspaceId: string;
  token: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Injeções exclusivas de teste para provar o teto sem usar `sleep` real. */
  now?: () => number;
  deadlineMs?: number;
}): Promise<ClickUpDiscoveredObject[]> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const sleep = input.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const deadlineMs = input.deadlineMs ?? CLICKUP_DISCOVERY_DEADLINE_MS;
  if (
    !Number.isInteger(deadlineMs) ||
    deadlineMs < 1 ||
    deadlineMs > CLICKUP_DISCOVERY_DEADLINE_MS
  ) {
    throw new Error("clickup_discovery_invalid_deadline");
  }
  const deadlineAt = now() + deadlineMs;
  const request = (path: string) => getJson(fetchImpl, input.token, path, sleep, deadlineAt, now);
  const rawSpaces = z
    .object({ spaces: z.array(z.object({ id: idSchema, name: z.string() }).passthrough()) })
    .parse(
      await request(`/team/${encodeURIComponent(input.workspaceId)}/space?archived=false`),
    ).spaces;
  const objects: ClickUpDiscoveredObject[] = [
    {
      source_type: "workspace",
      source_id: input.workspaceId,
      metadata: { name: `Workspace ${input.workspaceId}` },
      content_access: "none",
    },
  ];
  for (const space of rawSpaces) {
    objects.push({
      source_type: "space",
      source_id: space.id,
      parent_source_id: input.workspaceId,
      metadata: { name: space.name },
      content_access: "none",
    });
    const [foldersResponse, folderlessResponse] = await Promise.all([
      request(`/space/${encodeURIComponent(space.id)}/folder?archived=false`),
      request(`/space/${encodeURIComponent(space.id)}/list?archived=false`),
    ]);
    const folders = z
      .object({ folders: z.array(folderSchema).default([]) })
      .parse(foldersResponse).folders;
    const folderless = z
      .object({ lists: z.array(listSchema).default([]) })
      .parse(folderlessResponse).lists;
    const lists: Array<{
      list: z.infer<typeof listSchema>;
      folder: z.infer<typeof folderSchema> | null;
    }> = [];
    for (const folder of folders) {
      objects.push({
        source_type: "folder",
        source_id: folder.id,
        parent_source_id: space.id,
        metadata: { name: folder.name, space_id: space.id },
        content_access: "none",
      });
      for (const list of folder.lists) lists.push({ list, folder });
    }
    for (const list of folderless) lists.push({ list, folder: null });
    const processList = async ({ list: summary, folder }: (typeof lists)[number]) => {
      const list = listSchema.parse(await request(`/list/${encodeURIComponent(summary.id)}`));
      objects.push({
        source_type: "list",
        source_id: list.id,
        parent_source_id: folder?.id ?? space.id,
        metadata: {
          name: list.name,
          space_id: space.id,
          space_name: space.name,
          folder_id: folder?.id ?? null,
          folder_name: folder?.name ?? null,
        },
        content_access: "none",
      });
      for (const rawStatus of list.statuses) {
        const status = record(rawStatus);
        const statusId = text(status.id);
        objects.push({
          source_type: "status",
          source_id: `${list.id}:${statusId}`,
          parent_source_id: list.id,
          metadata: {
            list_id: list.id,
            source_status_id: statusId,
            name: text(status.status),
            type: text(status.type),
            orderindex: status.orderindex ?? null,
          },
          content_access: "none",
        });
      }
      const fieldsResponse = z
        .object({ fields: z.array(unknownRecord).default([]) })
        .parse(await request(`/list/${encodeURIComponent(list.id)}/field`));
      for (const field of fieldsResponse.fields) {
        const fieldId = text(field.id);
        objects.push({
          source_type: "custom_field",
          source_id: `${list.id}:${fieldId}`,
          parent_source_id: list.id,
          metadata: {
            list_id: list.id,
            source_field_id: fieldId,
            name: text(field.name),
            type: text(field.type),
            type_config: record(field.type_config),
          },
          content_access: "none",
        });
      }
      for (let page = 0; page < 1_000; page += 1) {
        const taskResponse = z
          .object({ tasks: z.array(unknownRecord).default([]), last_page: z.boolean().optional() })
          .parse(
            await request(
              `/list/${encodeURIComponent(list.id)}/task?archived=false&include_closed=true&subtasks=true&page=${page}`,
            ),
          );
        for (const task of taskResponse.tasks) {
          const taskId = text(task.id);
          if (
            objects.some((object) => object.source_type === "task" && object.source_id === taskId)
          ) {
            throw new Error(`clickup_task_multiple_lists:${taskId}`);
          }
          const metadata = safeTaskMetadata(task, list.id);
          objects.push({
            source_type: "task",
            source_id: taskId,
            parent_source_id: metadata.parent_id ?? list.id,
            source_revision: metadata.date_updated,
            metadata,
            content_access: "none",
          });
        }
        if (taskResponse.last_page === true || taskResponse.tasks.length < 100) break;
      }
    };
    let nextList = 0;
    await Promise.all(
      Array.from({ length: Math.min(CLICKUP_DISCOVERY_CONCURRENCY, lists.length) }, async () => {
        while (nextList < lists.length) {
          const index = nextList;
          nextList += 1;
          await processList(lists[index]!);
        }
      }),
    );
  }
  if (objects.length > 5_000) throw new Error("clickup_manifest_limit_exceeded");
  return objects;
}
