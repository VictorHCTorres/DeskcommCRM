import { describe, expect, it } from "vitest";

import { aggregateClickUpPreviewCoverage, clickUpCoverageBlocksExecution } from "./coverage";

describe("coverage segura do preview ClickUp", () => {
  it("classifica native/provenance/unsupported sem expor identidades", () => {
    const coverage = aggregateClickUpPreviewCoverage({
      archiveScope: "active_only",
      isResolvedAssigneeEmail: (email) => email === "membro@example.com",
      taskMetadata: [
        {
          priority: "high",
          tags: [{ name: "radar" }, { name: "serviços" }],
          start_date: "1",
          time_estimate: 1000,
          linked_tasks: [{ task_id: "a", link_id: "b" }],
          checklists: [{ name: "C", items: [{ resolved: true }] }],
          watcher_ids: ["watcher-secret"],
          assignees: [{ email: "membro@example.com" }, { email: "fora@example.com" }],
        },
      ],
    });
    expect(coverage).toMatchObject({
      archive_scope: "active_only",
      coverage: "partial",
      assignees: { assignments: 2, resolved: 1, unresolved: 1 },
    });
    expect(coverage.dimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "priority", classification: "native", present: 1 }),
        expect.objectContaining({ key: "checklists", classification: "provenance", present: 1 }),
      ]),
    );
    expect(JSON.stringify(coverage)).not.toContain("example.com");
    expect(JSON.stringify(coverage)).not.toContain("watcher-secret");
  });

  it("bloqueia campos descartados, mas aceita time_spent preservado como proveniência", () => {
    const coverage = aggregateClickUpPreviewCoverage({
      taskMetadata: [{ dependencies: [{}], locations: [{}], archived: true, time_spent_ms: 10 }],
    });
    expect(
      coverage.warnings.filter((warning) => warning.blocking).map((warning) => warning.code),
    ).toEqual(["unsupported_dependencies", "unsupported_locations", "unsupported_archived_tasks"]);
    expect(coverage.warnings).toContainEqual({
      code: "time_spent_preserved_as_provenance",
      blocking: false,
      count: 1,
    });
    expect(coverage.dimensions.find((dimension) => dimension.key === "time_spent")).toEqual({
      key: "time_spent",
      classification: "provenance",
      present: 1,
    });
  });

  it("conta relações staged e reconhece varredura ativa e arquivada como completa", () => {
    const coverage = aggregateClickUpPreviewCoverage({
      archiveScope: "active_and_archived",
      relationRecords: 14,
      taskMetadata: [{ linked_tasks: [{ link_id: "não duplica o total staged" }] }],
    });
    expect(coverage.coverage).toBe("full");
    expect(clickUpCoverageBlocksExecution(coverage)).toBe(false);
    expect(coverage.dimensions.find((dimension) => dimension.key === "links")?.present).toBe(14);
  });

  it("o gate do servidor recusa cobertura parcial e qualquer blocker unsupported", () => {
    const partial = aggregateClickUpPreviewCoverage({
      taskMetadata: [],
      archiveScope: "active_only",
    });
    const unsupported = aggregateClickUpPreviewCoverage({
      taskMetadata: [{ locations: [{}] }],
      archiveScope: "active_and_archived",
    });
    expect(clickUpCoverageBlocksExecution(partial)).toBe(true);
    expect(clickUpCoverageBlocksExecution(unsupported)).toBe(true);
  });

  it("distingue estimativas preenchidas das estritamente positivas", () => {
    const coverage = aggregateClickUpPreviewCoverage({
      taskMetadata: [
        { time_estimate: 0 },
        { time_estimate: 3_600_000 },
        { time_estimate: null },
        {},
      ],
    });
    expect(coverage.dimensions.find((dimension) => dimension.key === "time_estimate")).toEqual({
      key: "time_estimate",
      classification: "native",
      present: 2,
      detail: 1,
    });
  });
});
