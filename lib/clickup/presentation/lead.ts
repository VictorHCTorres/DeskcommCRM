export type ClickUpLeadPriority = "low" | "medium" | "high" | "urgent";

export function formatClickUpEstimate(milliseconds: number): string {
  const minutes = Math.max(0, Math.round(milliseconds / 60_000));
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}min` : `${hours}h`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Projeta somente campos operacionais seguros; a UI nunca recebe/renderiza metadata bruta. */
export function clickUpLeadPresentation(
  sourceMetadata: unknown,
  tags: unknown,
): {
  priority: ClickUpLeadPriority | null;
  tags: string[];
  startAt: string | null;
  timeEstimateMs: number | null;
} {
  const root = isRecord(sourceMetadata) ? sourceMetadata : {};
  const clickup = isRecord(root.clickup) ? root.clickup : {};
  const rawPriority = clickup.priority === "normal" ? "medium" : clickup.priority;
  const priority =
    rawPriority === "low" ||
    rawPriority === "medium" ||
    rawPriority === "high" ||
    rawPriority === "urgent"
      ? rawPriority
      : null;
  const safeTags = Array.isArray(tags)
    ? [
        ...new Set(
          tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ]
    : [];
  const startAt =
    typeof clickup.start_at === "string" && !Number.isNaN(Date.parse(clickup.start_at))
      ? clickup.start_at
      : null;
  const estimate = Number(clickup.time_estimate_ms);
  const timeEstimateMs =
    Number.isSafeInteger(estimate) && estimate >= 0 && clickup.time_estimate_ms !== null
      ? estimate
      : null;
  return { priority, tags: safeTags, startAt, timeEstimateMs };
}
