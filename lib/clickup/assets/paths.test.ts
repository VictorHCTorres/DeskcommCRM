import { describe, expect, it } from "vitest";

import { clickUpAssetFinalPath, isClickUpAssetFinalPathOwnedBy } from "./paths";

describe("path final privado dos assets ClickUp", () => {
  it("é determinístico e preso ao tenant/alvo", () => {
    const path = clickUpAssetFinalPath({
      organizationId: "org-1",
      workspaceId: "wk-1",
      targetKind: "tasks",
      targetId: "task-1",
      sha256: "a".repeat(64),
      extension: "pdf",
    });
    expect(isClickUpAssetFinalPathOwnedBy(path, "org-1", "tasks", "task-1")).toBe(true);
    expect(isClickUpAssetFinalPathOwnedBy(path, "org-2", "tasks", "task-1")).toBe(false);
    expect(isClickUpAssetFinalPathOwnedBy(path, "org-1", "tasks", "task-2")).toBe(false);
    expect(
      isClickUpAssetFinalPathOwnedBy(
        path.replace(`${"a".repeat(64)}.pdf`, "../segredo"),
        "org-1",
        "tasks",
        "task-1",
      ),
    ).toBe(false);
  });
});
