import { describe, expect, it } from "vitest";

import { clickupSidecarCoverageSchema } from "@/lib/clickup/sidecar-contrato";

import {
  coverageCompletaClickUpV4,
  coverageLegadoClickUpV4,
  TASKS_ESPERADAS_CLICKUP,
  type CoverageClickUpV4,
} from "./coverage";

describe("coverage ClickUp v4", () => {
  it("só declara complete com as 1.983 Tasks e cursores terminais", () => {
    const ids = Array.from({ length: TASKS_ESPERADAS_CLICKUP }, (_, indice) => `t${indice}`);
    const coverage: CoverageClickUpV4 = {
      tasks_expected: TASKS_ESPERADAS_CLICKUP,
      tasks_comments_scanned: TASKS_ESPERADAS_CLICKUP,
      attachment_parents_scanned: TASKS_ESPERADAS_CLICKUP,
      terminal_cursors: [
        ...ids.map((id) => ({
          kind: "task_comments" as const,
          parent_external_id: id,
          cursor: null,
          terminal: true as const,
        })),
        ...ids.map((id) => ({
          kind: "tasks" as const,
          parent_external_id: id,
          cursor: null,
          terminal: true as const,
        })),
      ],
      comments_found: 50,
      replies_found: 2,
      assets_found: 3,
      bytes_declared: 100,
      bytes_downloaded: 0,
      warnings: [],
      skips: [],
    };
    expect(clickupSidecarCoverageSchema.safeParse(coverage).success).toBe(true);
    expect(coverageCompletaClickUpV4(coverage)).toBe(true);
    expect(coverageCompletaClickUpV4({ ...coverage, attachment_parents_scanned: 1_982 })).toBe(
      false,
    );
  });

  it("snapshot legado é unknown_not_exported, nunca zero comprovado", () => {
    const coverage = coverageLegadoClickUpV4();
    expect(coverageCompletaClickUpV4(coverage)).toBe(false);
    expect(coverage.tasks_expected).toBe(1_983);
    expect(coverage.skips).toEqual([{ reason: "unknown_not_exported", count: 1_983 }]);
    expect(clickupSidecarCoverageSchema.safeParse(coverage).success).toBe(true);
  });
});
