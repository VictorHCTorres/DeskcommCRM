type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

export const CLICKUP_TASK_CONTEXT_MAX_BYTES = 96 * 1024;
export const CLICKUP_TASK_CONTEXT_MAX_ITEMS = 500;

function boundedText(value: unknown, maxLength = 512): string | null {
  const normalized = text(value).trim();
  if (!normalized) return null;
  if (normalized.length > maxLength) throw new Error("clickup_task_context_string_too_large");
  return normalized;
}

function boundedArray(value: unknown, key: string): unknown[] {
  const normalized = array(value);
  if (normalized.length > CLICKUP_TASK_CONTEXT_MAX_ITEMS) {
    throw new Error(`clickup_task_context_${key}_too_many`);
  }
  return normalized;
}

function hasOperationalValue(value: unknown): boolean {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    (!Array.isArray(value) || value.length > 0)
  );
}

function boundedTaskContext<T>(context: T): T {
  const serialized = JSON.stringify(context);
  if (Buffer.byteLength(serialized, "utf8") > CLICKUP_TASK_CONTEXT_MAX_BYTES) {
    throw new Error("clickup_task_context_too_large");
  }
  return context;
}

export type ClickUpPriority = "urgent" | "high" | "normal" | "low" | null;

export function normalizeClickUpPriority(value: unknown): ClickUpPriority {
  const raw = text(record(value).priority || value)
    .trim()
    .toLowerCase();
  return raw === "urgent" || raw === "high" || raw === "normal" || raw === "low" ? raw : null;
}

export function clickUpPriorityToCrm(value: unknown): "urgent" | "high" | "medium" | "low" {
  const priority = normalizeClickUpPriority(value);
  return priority === "urgent" || priority === "high" || priority === "low" ? priority : "medium";
}

export function normalizeClickUpTags(value: unknown) {
  const byName = new Map<string, { name: string; color: string | null }>();
  for (const candidate of array(value)) {
    const tag = record(candidate);
    const name = text(tag.name).trim();
    if (!name) continue;
    const key = name.toLocaleLowerCase("pt-BR");
    if (!byName.has(key)) {
      byName.set(key, {
        name,
        color: text(tag.color || tag.tag_bg || tag.tag_fg).trim() || null,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function clickUpTagNames(value: unknown): string[] {
  return normalizeClickUpTags(value).map((tag) => tag.name);
}

export function epochMillisecondsToIso(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric =
    typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric ?? String(value));
  if (Number.isNaN(date.getTime())) throw new Error("clickup_timestamp_invalid");
  return date.toISOString();
}

export function normalizeNonNegativeMilliseconds(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("clickup_duration_invalid");
  return parsed;
}

export function clickUpFidelityMetadata(
  metadata: JsonRecord,
  origin: { workspaceId?: unknown; parentExternalId?: unknown } = {},
) {
  const provenance = record(metadata.provenance);
  const listId = boundedText(metadata.list_id);
  const explicitSourceListIds = boundedArray(provenance.source_list_ids, "source_lists")
    .map((value) => boundedText(value))
    .filter((value): value is string => value !== null);
  const sourceListIds = explicitSourceListIds.length
    ? explicitSourceListIds
    : listId
      ? [listId]
      : [];
  const assignees = boundedArray(metadata.assignees, "assignees").flatMap((candidate) => {
    const assignee = record(candidate);
    let sourceUserId = boundedText(assignee.source_user_id);
    if (!sourceUserId) sourceUserId = boundedText(assignee.id);
    let displayName = boundedText(assignee.display_name, 255);
    if (!displayName) displayName = boundedText(assignee.username, 255);
    const normalized = {
      source_user_id: sourceUserId,
      display_name: displayName,
    };
    const hasIdentity = [normalized.source_user_id, normalized.display_name].some(Boolean);
    return hasIdentity ? [normalized] : [];
  });
  const nonEmptyCustomFields = array(metadata.custom_fields).filter((candidate) =>
    hasOperationalValue(record(candidate).value),
  );
  const customFields = boundedArray(nonEmptyCustomFields, "custom_fields").map((candidate) => {
    const field = record(candidate);
    return {
      id: boundedText(field.id),
      name: boundedText(field.name, 255),
      type: boundedText(field.type, 80),
      value: field.value,
      selected_options: boundedArray(field.selected_options, "custom_field_options").map(
        (candidateOption) => {
          const option = record(candidateOption);
          return { id: boundedText(option.id), label: boundedText(option.label, 255) };
        },
      ),
    };
  });
  const linkedTasks = boundedArray(metadata.linked_tasks, "linked_tasks").map((candidate) => {
    const relation = record(candidate);
    return {
      task_id: boundedText(relation.task_id),
      link_id: boundedText(relation.link_id),
      date_created: epochMillisecondsToIso(relation.date_created),
    };
  });
  const dependencies = boundedArray(metadata.dependencies, "dependencies").map((candidate) => {
    const dependency = record(candidate);
    return {
      task_id: boundedText(dependency.task_id),
      depends_on: boundedText(dependency.depends_on),
    };
  });
  return boundedTaskContext({
    schema_version: 1,
    hierarchy: {
      workspace_id: boundedText(origin.workspaceId ?? metadata.workspace_id, 255),
      space_id: boundedText(metadata.space_id),
      space_name: boundedText(metadata.space_name, 255),
      folder_id: boundedText(metadata.folder_id),
      folder_name: boundedText(metadata.folder_name, 255),
      list_id: listId,
      list_name: boundedText(metadata.list_name, 255),
      source_list_ids: sourceListIds,
      multiple_lists: provenance.multiple_lists === true || sourceListIds.length > 1,
    },
    status: {
      id: boundedText(metadata.status_id),
      name: boundedText(metadata.status_name, 255),
      type: boundedText(metadata.status_type, 80),
    },
    assignees,
    custom_fields: customFields,
    parent_external_id: boundedText(origin.parentExternalId ?? metadata.parent_id),
    priority: normalizeClickUpPriority(metadata.priority),
    tags: normalizeClickUpTags(metadata.tags),
    start_at: epochMillisecondsToIso(metadata.start_date),
    due_at: epochMillisecondsToIso(metadata.due_date),
    done_at: epochMillisecondsToIso(metadata.date_done),
    closed_at: epochMillisecondsToIso(metadata.date_closed),
    time_estimate_ms: normalizeNonNegativeMilliseconds(metadata.time_estimate),
    time_spent_ms: normalizeNonNegativeMilliseconds(metadata.time_spent),
    watcher_ids: boundedArray(metadata.watcher_ids, "watchers").map(text).filter(Boolean),
    watcher_count: Number(metadata.watcher_count ?? array(metadata.watcher_ids).length),
    archived: metadata.archived === true,
    url: boundedText(metadata.url, 2_048),
    source_created_at: epochMillisecondsToIso(metadata.source_created_at ?? metadata.date_created),
    source_updated_at: epochMillisecondsToIso(metadata.source_updated_at ?? metadata.date_updated),
    orderindex: boundedText(metadata.orderindex),
    locations: boundedArray(metadata.locations, "locations"),
    linked_tasks: linkedTasks,
    dependencies,
    archive_scope: boundedText(metadata.archive_scope, 80) ?? "unknown",
    provenance,
    warnings: boundedArray(metadata.fidelity_warnings, "warnings"),
    checklists: boundedArray(metadata.checklists, "checklists"),
  });
}

export type ClickUpRelation = {
  relation_type: "linked" | "dependency";
  source_task_id: string;
  target_task_id: string;
  source_id: string;
};

export function canonicalClickUpRelations(taskId: string, metadata: JsonRecord): ClickUpRelation[] {
  const relations = new Map<string, ClickUpRelation>();
  for (const candidate of array(metadata.linked_tasks)) {
    const link = record(candidate);
    const first = text(link.task_id) || taskId;
    const second = text(link.link_id);
    if (!first || !second || first === second) continue;
    const [left, right] = [first, second].sort();
    const sourceId = `linked:${left}:${right}`;
    relations.set(sourceId, {
      relation_type: "linked",
      source_task_id: left!,
      target_task_id: right!,
      source_id: sourceId,
    });
  }
  for (const candidate of array(metadata.dependencies)) {
    const dependency = record(candidate);
    const explicitTarget = text(dependency.depends_on);
    const source = explicitTarget ? text(dependency.task_id) || taskId : taskId;
    const target = explicitTarget || text(dependency.task_id);
    if (!source || !target || source === target) continue;
    const sourceId = `dependency:${source}:${target}`;
    relations.set(sourceId, {
      relation_type: "dependency",
      source_task_id: source,
      target_task_id: target,
      source_id: sourceId,
    });
  }
  return [...relations.values()].sort((a, b) => a.source_id.localeCompare(b.source_id));
}
