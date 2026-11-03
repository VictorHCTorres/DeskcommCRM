import { describe, expect, it } from "vitest";

import { instanteAposConclusao, instanteDaGeracao } from "@/lib/tarefas/recorrencia";

describe("cálculo de recorrência", () => {
  it("preserva hora de parede ao atravessar o DST", () => {
    const regra = { frequency: "daily" as const, interval: 1, timezone: "America/New_York" };
    const antes = new Date("2026-03-07T14:00:00.000Z"); // 09:00 EST
    expect(instanteDaGeracao(antes, 1, regra).toISOString()).toBe("2026-03-08T13:00:00.000Z");
  });

  it("dia 31 cai no último válido e volta ao 31 no mês seguinte", () => {
    const regra = { frequency: "monthly" as const, interval: 1, timezone: "UTC" };
    const ancora = new Date("2027-01-31T09:00:00.000Z");
    expect(instanteDaGeracao(ancora, 1, regra).toISOString()).toBe("2027-02-28T09:00:00.000Z");
    expect(instanteDaGeracao(ancora, 2, regra).toISOString()).toBe("2027-03-31T09:00:00.000Z");
  });

  it("após conclusão conta do instante concluído", () => {
    expect(
      instanteAposConclusao(new Date("2026-11-02T12:00:00.000Z"), {
        frequency: "weekly",
        interval: 2,
        timezone: "UTC",
      }).toISOString(),
    ).toBe("2026-11-16T12:00:00.000Z");
  });
});
