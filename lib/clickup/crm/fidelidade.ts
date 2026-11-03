type JsonRecord = Record<string, unknown>;

const record = (value: unknown): JsonRecord =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

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

export function clickUpFidelityMetadata(metadata: JsonRecord) {
  return {
    priority: normalizeClickUpPriority(metadata.priority),
    tags: normalizeClickUpTags(metadata.tags),
    start_at: epochMillisecondsToIso(metadata.start_date),
    time_estimate_ms: normalizeNonNegativeMilliseconds(metadata.time_estimate),
    time_spent_ms: normalizeNonNegativeMilliseconds(metadata.time_spent),
    watcher_ids: array(metadata.watcher_ids).map(text).filter(Boolean),
    watcher_count: Number(metadata.watcher_count ?? array(metadata.watcher_ids).length),
    archived: metadata.archived === true,
    url: text(metadata.url) || null,
    source_created_at: epochMillisecondsToIso(metadata.source_created_at ?? metadata.date_created),
    source_updated_at: epochMillisecondsToIso(metadata.source_updated_at ?? metadata.date_updated),
    orderindex: text(metadata.orderindex) || null,
    locations: array(metadata.locations),
    archive_scope: text(metadata.archive_scope) || "unknown",
    provenance: record(metadata.provenance),
    warnings: array(metadata.fidelity_warnings),
    checklists: array(metadata.checklists),
  };
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
