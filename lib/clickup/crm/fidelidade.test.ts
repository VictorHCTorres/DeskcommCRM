import { describe, expect, it } from "vitest";

import {
  canonicalClickUpRelations,
  clickUpFidelityMetadata,
  clickUpPriorityToCrm,
  normalizeClickUpTags,
} from "./fidelidade";

describe("fidelidade operacional ClickUp", () => {
  it("mapeia prioridade sem inventar urgência e ordena tags deterministicamente", () => {
    expect(clickUpPriorityToCrm({ priority: "normal" })).toBe("medium");
    expect(clickUpPriorityToCrm({ priority: "urgent" })).toBe("urgent");
    expect(clickUpPriorityToCrm(null)).toBe("medium");
    expect(
      normalizeClickUpTags([
        { name: "VIP", tag_bg: "#fff" },
        { name: "alpha", tag_fg: "#000" },
        { name: "vip", tag_bg: "#f00" },
      ]),
    ).toEqual([
      { name: "alpha", color: "#000" },
      { name: "VIP", color: "#fff" },
    ]);
  });

  it("preserva datas, estimativa zero e proveniência sem e-mail de watcher", () => {
    const metadata = clickUpFidelityMetadata({
      start_date: "1710052200000",
      time_estimate: 0,
      time_spent: 12,
      watcher_ids: ["2", "1"],
      watcher_count: 2,
      archive_scope: "active_and_archived",
      provenance: { include_timl: true },
    });
    expect(metadata).toMatchObject({
      start_at: "2024-03-10T06:30:00.000Z",
      time_estimate_ms: 0,
      time_spent_ms: 12,
      watcher_ids: ["2", "1"],
      watcher_count: 2,
      archive_scope: "active_and_archived",
      provenance: { include_timl: true },
    });
    expect(JSON.stringify(metadata)).not.toContain("@");
  });

  it("reduz os dois lados de linked_tasks ao mesmo par canônico", () => {
    const one = canonicalClickUpRelations("a", {
      linked_tasks: [{ task_id: "a", link_id: "b" }],
    });
    const other = canonicalClickUpRelations("b", {
      linked_tasks: [{ task_id: "a", link_id: "b" }],
    });
    expect(one).toEqual(other);
    expect(one).toEqual([
      {
        relation_type: "linked",
        source_task_id: "a",
        target_task_id: "b",
        source_id: "linked:a:b",
      },
    ]);
  });
});
