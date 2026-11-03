import type { ClickUpSidecar } from "@/lib/clickup/sidecar-contrato";

export const TASKS_ESPERADAS_CLICKUP = 1_983;
export type CoverageClickUpV4 = ClickUpSidecar["coverage"];

export function coverageCompletaClickUpV4(coverage: CoverageClickUpV4): boolean {
  const commentsTerminais = new Set(
    coverage.terminal_cursors
      .filter((cursor) => cursor.kind === "task_comments" && cursor.terminal)
      .map((cursor) => cursor.parent_external_id),
  );
  const attachmentsTerminais = new Set(
    coverage.terminal_cursors
      .filter((cursor) => cursor.kind === "tasks" && cursor.terminal)
      .map((cursor) => cursor.parent_external_id),
  );
  return (
    coverage.tasks_comments_scanned === coverage.tasks_expected &&
    coverage.attachment_parents_scanned >= coverage.tasks_expected &&
    commentsTerminais.size === coverage.tasks_expected &&
    attachmentsTerminais.size === coverage.tasks_expected
  );
}

export function coverageLegadoClickUpV4(
  tasksExpected = TASKS_ESPERADAS_CLICKUP,
): CoverageClickUpV4 {
  return {
    tasks_expected: tasksExpected,
    tasks_comments_scanned: 0,
    attachment_parents_scanned: 0,
    terminal_cursors: [{ kind: "tasks", parent_external_id: null, cursor: null, terminal: true }],
    comments_found: 0,
    replies_found: 0,
    assets_found: 0,
    bytes_declared: 0,
    bytes_downloaded: 0,
    warnings: [{ code: "legacy_snapshot_without_comments_or_attachments" }],
    skips: [{ reason: "unknown_not_exported", count: tasksExpected }],
  };
}
