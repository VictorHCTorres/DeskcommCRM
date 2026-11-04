type Row = Record<string, unknown>;

const record = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};

export function clickUpSidecarSatisfiesGate(job: unknown): boolean {
  const row = record(job);
  return row.mode === "full" && row.include_private_docs === true && row.status === "completed";
}

/**
 * `ready` significa blob íntegro na quarantine. A promoção só pode acontecer
 * depois que o destino CRM existir e é um gate separado antes do corte.
 */
export function clickUpAssetSidecarSatisfiesExecutionGate(sidecar: unknown): boolean {
  const row = record(sidecar);
  return row.mode === "full" && (row.status === "ready" || row.status === "completed");
}
