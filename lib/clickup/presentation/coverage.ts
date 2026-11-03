type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";
const estimateOf = (row: Row): unknown =>
  Object.prototype.hasOwnProperty.call(row, "time_estimate_ms")
    ? row.time_estimate_ms
    : row.time_estimate;

export type ClickUpCoverageClass = "native" | "provenance" | "unsupported";

export interface ClickUpPreviewCoverage {
  archive_scope: "active_only" | "full";
  coverage: "partial" | "full";
  tasks_scanned: number;
  dimensions: Array<{
    key: string;
    classification: ClickUpCoverageClass;
    present: number;
    detail?: number;
  }>;
  assignees: { assignments: number; resolved: number; unresolved: number };
  warnings: Array<{ code: string; blocking: boolean; count: number }>;
}

/** O servidor repete este gate no execute; a UI é apenas feedback antecipado. */
export function clickUpCoverageBlocksExecution(coverage: ClickUpPreviewCoverage): boolean {
  return coverage.coverage !== "full" || coverage.warnings.some((warning) => warning.blocking);
}

/** Agrega apenas números e códigos; identidades, e-mails e metadata não saem da API. */
export function aggregateClickUpPreviewCoverage(input: {
  taskMetadata: unknown[];
  archiveScope?: unknown;
  relationRecords?: number;
  isResolvedAssigneeEmail?: (email: string) => boolean;
}): ClickUpPreviewCoverage {
  const tasks = input.taskMetadata.map(record);
  const count = (predicate: (row: Row) => boolean) => tasks.filter(predicate).length;
  let tagAssignments = 0;
  let relationRecords = input.relationRecords ?? 0;
  let checklistGroups = 0;
  let checklistItems = 0;
  let assignments = 0;
  let resolved = 0;
  let dependencies = 0;
  let locations = 0;
  let archived = 0;
  let timeSpent = 0;
  let positiveEstimates = 0;
  for (const task of tasks) {
    tagAssignments += array(task.tags).length;
    if (input.relationRecords == null) relationRecords += array(task.linked_tasks).length;
    const checklists = array(task.checklists);
    checklistGroups += checklists.length;
    checklistItems += checklists.reduce<number>(
      (total, checklist) => total + array(record(checklist).items).length,
      0,
    );
    for (const assignee of array(task.assignees)) {
      assignments += 1;
      const email = text(record(assignee).email).trim().toLowerCase();
      if (email && input.isResolvedAssigneeEmail?.(email)) resolved += 1;
    }
    dependencies += array(task.dependencies).length;
    locations += array(task.locations).length;
    if (task.archived === true) archived += 1;
    const spent = Number(task.time_spent_ms ?? task.time_spent ?? 0);
    if (Number.isFinite(spent) && spent > 0) timeSpent += 1;
    const estimate = estimateOf(task);
    if (Number.isFinite(Number(estimate)) && Number(estimate) > 0) positiveEstimates += 1;
  }
  const archiveScope =
    input.archiveScope === "full" || input.archiveScope === "active_and_archived"
      ? "full"
      : "active_only";
  const warnings = [
    ...(archiveScope === "active_only"
      ? [{ code: "archive_scope_active_only", blocking: false, count: 1 }]
      : []),
    ...(dependencies
      ? [{ code: "unsupported_dependencies", blocking: true, count: dependencies }]
      : []),
    ...(locations ? [{ code: "unsupported_locations", blocking: true, count: locations }] : []),
    ...(archived ? [{ code: "unsupported_archived_tasks", blocking: true, count: archived }] : []),
    ...(timeSpent ? [{ code: "unsupported_time_spent", blocking: true, count: timeSpent }] : []),
  ];
  return {
    archive_scope: archiveScope,
    coverage: archiveScope === "full" ? "full" : "partial",
    tasks_scanned: tasks.length,
    dimensions: [
      { key: "priority", classification: "native", present: count((row) => Boolean(row.priority)) },
      {
        key: "tags",
        classification: "native",
        present: count((row) => array(row.tags).length > 0),
        detail: tagAssignments,
      },
      {
        key: "start_date",
        classification: "native",
        present: count((row) => Boolean(row.start_at ?? row.start_date)),
      },
      {
        key: "time_estimate",
        classification: "native",
        present: count((row) => {
          const estimate = estimateOf(row);
          return estimate !== null && estimate !== undefined && estimate !== "";
        }),
        detail: positiveEstimates,
      },
      { key: "links", classification: "native", present: relationRecords },
      {
        key: "checklists",
        classification: "provenance",
        present: checklistGroups,
        detail: checklistItems,
      },
      {
        key: "watchers",
        classification: "provenance",
        present: count((row) => array(row.watcher_ids).length > 0),
      },
      { key: "dependencies", classification: "unsupported", present: dependencies },
      { key: "locations", classification: "unsupported", present: locations },
      { key: "archived", classification: "unsupported", present: archived },
      { key: "time_spent", classification: "unsupported", present: timeSpent },
    ],
    assignees: { assignments, resolved, unresolved: assignments - resolved },
    warnings,
  };
}
