import { describe, expect, it } from "vitest";

import { clickUpAssetSidecarSatisfiesExecutionGate, clickUpSidecarSatisfiesGate } from "./gate";

describe("gate da coleta completa do ClickUp", () => {
  it("não aceita inventário, coleta em andamento nem coleta com erro", () => {
    expect(
      clickUpSidecarSatisfiesGate({
        mode: "full",
        include_private_docs: true,
        status: "completed",
      }),
    ).toBe(true);
    expect(
      clickUpSidecarSatisfiesGate({
        mode: "full",
        include_private_docs: false,
        status: "completed",
      }),
    ).toBe(false);
    expect(clickUpSidecarSatisfiesGate({ mode: "inventory", status: "completed" })).toBe(false);
    expect(clickUpSidecarSatisfiesGate({ mode: "full", status: "running" })).toBe(false);
    expect(clickUpSidecarSatisfiesGate({ mode: "full", status: "completed_with_errors" })).toBe(
      false,
    );
  });

  it("aceita quarantine íntegra para executar, mas não inventário nem falha", () => {
    expect(clickUpAssetSidecarSatisfiesExecutionGate({ mode: "full", status: "ready" })).toBe(true);
    expect(clickUpAssetSidecarSatisfiesExecutionGate({ mode: "full", status: "completed" })).toBe(
      true,
    );
    expect(clickUpAssetSidecarSatisfiesExecutionGate({ mode: "inventory", status: "ready" })).toBe(
      false,
    );
    expect(clickUpAssetSidecarSatisfiesExecutionGate({ mode: "full", status: "failed" })).toBe(
      false,
    );
  });
});
