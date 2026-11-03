import { describe, expect, it } from "vitest";

import { clickUpLeadPresentation, formatClickUpEstimate } from "./lead";

describe("clickUpLeadPresentation", () => {
  it("normaliza prioridade normal e deduplica tags visíveis", () => {
    expect(
      clickUpLeadPresentation(
        {
          clickup: {
            priority: "normal",
            start_at: "2026-11-03T12:00:00.000Z",
            time_estimate_ms: 7_200_000,
            watcher_email: "nao-vaza@example.com",
          },
        },
        ["Cliente", " Cliente ", "", 7],
      ),
    ).toEqual({
      priority: "medium",
      tags: ["Cliente"],
      startAt: "2026-11-03T12:00:00.000Z",
      timeEstimateMs: 7_200_000,
    });
  });

  it("ignora prioridade e metadata fora do contrato", () => {
    expect(clickUpLeadPresentation({ clickup: { priority: "critical" } }, null)).toEqual({
      priority: null,
      tags: [],
      startAt: null,
      timeEstimateMs: null,
    });
  });

  it("formata estimativa sem arredondar meia hora para zero", () => {
    expect(formatClickUpEstimate(30 * 60_000)).toBe("30min");
    expect(formatClickUpEstimate(90 * 60_000)).toBe("1h 30min");
  });
});
