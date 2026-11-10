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
/** 90 req/min deixam margem sob o piso de 100 req/min dos planos menores. */
export const CLICKUP_MIN_REQUEST_INTERVAL_MS = 667;
const CLICKUP_MAX_SERVER_BACKOFF_MS = 5_000;
const CLICKUP_RATE_LIMIT_FALLBACK_MS = 60_000;
const CLICKUP_RATE_LIMIT_RESET_MARGIN_MS = 250;

interface ClickUpRequestGate {
  enter(): Promise<void>;
  blockUntil(timestamp: number): void;
}

function createRequestGate(input: {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  deadlineAt: number;
  intervalMs: number;
}): ClickUpRequestGate {
  let nextRequestAt = input.now();
  let blockedUntil = 0;
  let queue = Promise.resolve();
  return {
    enter() {
      const turn = queue.then(async () => {
        while (true) {
          const current = input.now();
          const target = Math.max(current, nextRequestAt, blockedUntil);
          const delay = target - current;
          if (delay > 0) {
            const remaining = input.deadlineAt - current;
            if (remaining <= 0) throw new Error("clickup_discovery_deadline_exceeded");
            await input.sleep(Math.min(delay, remaining));
            continue;
          }
          if (current >= input.deadlineAt) {
            throw new Error("clickup_discovery_deadline_exceeded");
          }
          nextRequestAt = current + input.intervalMs;
          return;
        }
      });
      queue = turn.catch(() => undefined);
      return turn;
    },
    blockUntil(timestamp) {
      blockedUntil = Math.max(blockedUntil, timestamp);
    },
  };
}

function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

function rateLimitResetMs(value: string | null, now: number): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.max(0, seconds * 1_000 - now + CLICKUP_RATE_LIMIT_RESET_MARGIN_MS);
}

async function getJson(
  fetchImpl: typeof fetch,
  token: string,
  path: string,
  sleep: (ms: number) => Promise<void>,
  deadlineAt: number,
  now: () => number,
  gate: ClickUpRequestGate,
) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await gate.enter();
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
      const remainingBeforeSleep = deadlineAt - now();
      if (remainingBeforeSleep <= 0) throw new Error("clickup_discovery_deadline_exceeded");
      const backoff = 250 * 2 ** attempt;
      if (response.status === 429) {
        const current = now();
        const remoteDelay = Math.max(
          retryAfterMs(response.headers.get("retry-after"), current),
          rateLimitResetMs(response.headers.get("x-ratelimit-reset"), current),
        );
        const requestedDelay = Math.max(
          remoteDelay > 0 ? remoteDelay : CLICKUP_RATE_LIMIT_FALLBACK_MS,
          backoff,
        );
        gate.blockUntil(current + Math.min(requestedDelay, remainingBeforeSleep));
      } else {
        await sleep(Math.min(backoff, CLICKUP_MAX_SERVER_BACKOFF_MS, remainingBeforeSleep));
      }
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

function safeTags(value: unknown) {
  const unique = new Map<string, { name: string; color: string | null }>();
  for (const candidate of array(value)) {
    const tag = record(candidate);
    const name = text(tag.name).trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase("pt-BR");
    if (!unique.has(key)) {
      unique.set(key, { name, color: text(tag.tag_bg ?? tag.tag_fg) || null });
    }
  }
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

function nonEmptyCustomFieldValue(value: unknown) {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    (!Array.isArray(value) || value.length > 0)
  );
}

function safeTaskCustomFields(value: unknown) {
  return array(value).flatMap((candidate) => {
    const field = record(candidate);
    if (!nonEmptyCustomFieldValue(field.value)) return [];
    const type = text(field.type);
    const options = array(record(field.type_config).options).map((rawOption) => {
      const option = record(rawOption);
      return {
        id: text(option.id ?? option.value),
        label: text(option.name ?? option.label),
      };
    });
    const selections =
      type === "drop_down" ? [field.value] : type === "labels" ? array(field.value) : [];
    const selectedOptions = selections.flatMap((selection) => {
      const byId = options.find((candidateOption) => candidateOption.id === text(selection));
      const byIndex = Number.isInteger(Number(selection)) ? options[Number(selection)] : null;
      const option = byId ?? byIndex;
      return option?.id ? [option] : [];
    });
    return [
      {
        id: text(field.id),
        name: text(field.name),
        type,
        value: type === "drop_down" && selectedOptions[0]?.id ? selectedOptions[0].id : field.value,
        selected_options: selectedOptions,
      },
    ];
  });
}

function safeTaskMetadata(
  raw: Record<string, unknown>,
  hierarchy: {
    listId: string;
    listName: string;
    spaceId: string;
    spaceName: string;
    folderId: string | null;
    folderName: string | null;
  },
) {
  const status = record(raw.status);
  const attachmentsExported = Object.prototype.hasOwnProperty.call(raw, "attachments");
  const attachments = array(raw.attachments);
  return {
    list_id: hierarchy.listId,
    list_name: hierarchy.listName,
    space_id: hierarchy.spaceId,
    space_name: hierarchy.spaceName,
    folder_id: hierarchy.folderId,
    folder_name: hierarchy.folderName,
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
    priority: text(record(raw.priority).priority) || null,
    tags: safeTags(raw.tags),
    start_date: text(raw.start_date) || null,
    time_estimate: raw.time_estimate ?? null,
    time_spent: raw.time_spent ?? null,
    watcher_ids: [
      ...new Set(
        array(raw.watchers)
          .map((candidate) => text(record(candidate).id))
          .filter(Boolean),
      ),
    ].sort(),
    watcher_count: array(raw.watchers).length,
    linked_tasks: array(raw.linked_tasks).map((candidate) => ({
      task_id: text(record(candidate).task_id),
      link_id: text(record(candidate).link_id) || null,
      date_created: text(record(candidate).date_created) || null,
    })),
    dependencies: array(raw.dependencies).map((candidate) => ({
      task_id: text(record(candidate).task_id) || null,
      depends_on: text(record(candidate).depends_on) || null,
    })),
    locations: array(raw.locations).map((candidate) => {
      const location = record(candidate);
      return {
        id: text(location.id) || null,
        name: text(location.name) || null,
        latitude: location.latitude ?? null,
        longitude: location.longitude ?? null,
      };
    }),
    archived: raw.archived === true,
    url: text(raw.url) || null,
    source_created_at: text(raw.date_created) || null,
    source_updated_at: text(raw.date_updated) || null,
    orderindex: text(raw.orderindex) || null,
    archive_scope: "active_and_archived",
    provenance: { source: "clickup_api_v2", include_timl: true },
    fidelity_warnings: [
      ...(raw.archived === true ? [{ code: "clickup_archived_preserved_metadata_only" }] : []),
      ...(Number(raw.time_spent ?? 0) > 0
        ? [{ code: "clickup_time_spent_preserved_metadata_only" }]
        : []),
      ...(array(raw.locations).length > 0
        ? [{ code: "clickup_locations_preserved_metadata_only" }]
        : []),
      ...(array(raw.dependencies).length > 0
        ? [{ code: "clickup_dependencies_imported_as_relations" }]
        : []),
    ],
    assignees: array(raw.assignees).flatMap((candidate) => {
      const assignee = record(candidate);
      const email = text(assignee.email).trim().toLowerCase();
      const sourceUserId = text(assignee.id).trim();
      const displayName = text(assignee.username).trim();
      return email || sourceUserId || displayName
        ? [
            {
              email: email || null,
              source_user_id: sourceUserId || null,
              display_name: displayName || null,
            },
          ]
        : [];
    }),
    checklists: array(raw.checklists).map((candidate) => {
      const checklist = record(candidate);
      return {
        id: text(checklist.id),
        name: text(checklist.name),
        resolved: Number(checklist.resolved ?? 0),
        unresolved: Number(checklist.unresolved ?? 0),
        items: array(checklist.items).map((rawItem) => {
          const item = record(rawItem);
          return {
            id: text(item.id),
            name: text(item.name),
            resolved: item.resolved === true,
            orderindex: Number(item.orderindex ?? 0),
          };
        }),
      };
    }),
    custom_fields: safeTaskCustomFields(raw.custom_fields),
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
  /** Injeção de teste; produção usa uma cadência segura para planos de 100 req/min. */
  minRequestIntervalMs?: number;
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
  const minRequestIntervalMs = input.minRequestIntervalMs ?? CLICKUP_MIN_REQUEST_INTERVAL_MS;
  if (
    !Number.isInteger(minRequestIntervalMs) ||
    minRequestIntervalMs < 0 ||
    minRequestIntervalMs > 5_000
  ) {
    throw new Error("clickup_discovery_invalid_request_interval");
  }
  const deadlineAt = now() + deadlineMs;
  const gate = createRequestGate({ now, sleep, deadlineAt, intervalMs: minRequestIntervalMs });
  const request = (path: string) =>
    getJson(fetchImpl, input.token, path, sleep, deadlineAt, now, gate);
  const spaceResponseSchema = z.object({
    spaces: z.array(z.object({ id: idSchema, name: z.string() }).passthrough()),
  });
  const rawSpacesById = new Map<string, z.infer<typeof spaceResponseSchema>["spaces"][number]>();
  for (const archived of [false, true]) {
    for (const space of spaceResponseSchema.parse(
      await request(
        `/team/${encodeURIComponent(input.workspaceId)}/space?archived=${String(archived)}`,
      ),
    ).spaces) {
      rawSpacesById.set(space.id, { ...space, archived: space.archived === true || archived });
    }
  }
  const rawSpaces = [...rawSpacesById.values()];
  const objects: ClickUpDiscoveredObject[] = [
    {
      source_type: "workspace",
      source_id: input.workspaceId,
      metadata: {
        name: `Workspace ${input.workspaceId}`,
        archive_scope: "active_and_archived",
        coverage: {
          archive_scope: "active_and_archived",
          passes: ["archived=false", "archived=true"],
          include_timl: true,
        },
        provenance: { source: "clickup_api_v2" },
      },
      content_access: "none",
    },
  ];
  for (const space of rawSpaces) {
    objects.push({
      source_type: "space",
      source_id: space.id,
      parent_source_id: input.workspaceId,
      metadata: {
        name: space.name,
        archived: space.archived === true,
        archive_scope: "active_and_archived",
      },
      content_access: "none",
    });
    const folderById = new Map<string, z.infer<typeof folderSchema>>();
    const folderlessById = new Map<string, z.infer<typeof listSchema>>();
    for (const archived of [false, true]) {
      const [foldersResponse, folderlessResponse] = await Promise.all([
        request(`/space/${encodeURIComponent(space.id)}/folder?archived=${String(archived)}`),
        request(`/space/${encodeURIComponent(space.id)}/list?archived=${String(archived)}`),
      ]);
      for (const folder of z
        .object({ folders: z.array(folderSchema).default([]) })
        .parse(foldersResponse).folders) {
        folderById.set(folder.id, { ...folder, archived: folder.archived === true || archived });
      }
      for (const list of z
        .object({ lists: z.array(listSchema).default([]) })
        .parse(folderlessResponse).lists) {
        folderlessById.set(list.id, { ...list, archived: list.archived === true || archived });
      }
    }
    const folders = [...folderById.values()];
    const folderless = [...folderlessById.values()];
    const lists: Array<{
      list: z.infer<typeof listSchema>;
      folder: z.infer<typeof folderSchema> | null;
    }> = [];
    for (const folder of folders) {
      objects.push({
        source_type: "folder",
        source_id: folder.id,
        parent_source_id: space.id,
        metadata: {
          name: folder.name,
          space_id: space.id,
          archived: folder.archived === true,
          archive_scope: "active_and_archived",
        },
        content_access: "none",
      });
      const folderListsById = new Map<string, z.infer<typeof listSchema>>();
      for (const archived of [false, true]) {
        const response = z
          .object({ lists: z.array(listSchema).default([]) })
          .parse(
            await request(
              `/folder/${encodeURIComponent(folder.id)}/list?archived=${String(archived)}`,
            ),
          );
        for (const list of response.lists) {
          folderListsById.set(list.id, {
            ...list,
            archived: list.archived === true || archived,
          });
        }
      }
      for (const list of folderListsById.values()) lists.push({ list, folder });
    }
    for (const list of folderless) lists.push({ list, folder: null });
    const processList = async ({ list: summary, folder }: (typeof lists)[number]) => {
      const detail = listSchema.parse(await request(`/list/${encodeURIComponent(summary.id)}`));
      const list = { ...detail, archived: detail.archived === true || summary.archived === true };
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
          archived: list.archived === true,
          archive_scope: "active_and_archived",
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
      const taskIdsInList = new Set<string>();
      for (const archived of [false, true]) {
        for (let page = 0; page < 1_000; page += 1) {
          const taskResponse = z
            .object({
              tasks: z.array(unknownRecord).default([]),
              last_page: z.boolean().optional(),
            })
            .parse(
              await request(
                `/list/${encodeURIComponent(list.id)}/task?archived=${String(archived)}&include_closed=true&subtasks=true&include_timl=true&page=${page}`,
              ),
            );
          for (const task of taskResponse.tasks) {
            const taskId = text(task.id);
            if (taskIdsInList.has(taskId)) continue;
            if (
              objects.some((object) => object.source_type === "task" && object.source_id === taskId)
            ) {
              throw new Error(`clickup_task_multiple_lists:${taskId}`);
            }
            taskIdsInList.add(taskId);
            const metadata = safeTaskMetadata(task, {
              listId: list.id,
              listName: list.name,
              spaceId: space.id,
              spaceName: space.name,
              folderId: folder?.id ?? null,
              folderName: folder?.name ?? null,
            });
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
  const relations = new Map<string, ClickUpDiscoveredObject>();
  for (const object of objects.filter((candidate) => candidate.source_type === "task")) {
    for (const candidate of array(object.metadata.linked_tasks)) {
      const link = record(candidate);
      const first = text(link.task_id) || object.source_id;
      const second = text(link.link_id);
      if (!first || !second || first === second) continue;
      const [left, right] = [first, second].sort();
      const relationId = `linked:${left}:${right}`;
      const previous = relations.get(relationId);
      const previousProvenance = record(previous?.metadata.provenance);
      relations.set(relationId, {
        source_type: "task_relation",
        source_id: relationId,
        parent_source_id: left,
        source_revision: text(record(candidate).date_created) || null,
        metadata: {
          relation_type: "linked",
          source_task_id: left,
          target_task_id: right,
          provenance: {
            source: "linked_tasks",
            raw_occurrences: Number(previousProvenance.raw_occurrences ?? 0) + 1,
          },
        },
        content_access: "none",
      });
    }
    for (const candidate of array(object.metadata.dependencies)) {
      const dependency = record(candidate);
      const explicitTarget = text(dependency.depends_on);
      const source = explicitTarget
        ? text(dependency.task_id) || object.source_id
        : object.source_id;
      const target = explicitTarget || text(dependency.task_id);
      if (!source || !target || source === target) continue;
      const relationId = `dependency:${source}:${target}`;
      relations.set(relationId, {
        source_type: "task_relation",
        source_id: relationId,
        parent_source_id: source,
        metadata: {
          relation_type: "dependency",
          source_task_id: source,
          target_task_id: target,
          provenance: { source: "dependencies" },
        },
        content_access: "none",
      });
    }
  }
  objects.push(...relations.values());
  if (objects.length > 10_000) throw new Error("clickup_manifest_limit_exceeded");
  return objects;
}
