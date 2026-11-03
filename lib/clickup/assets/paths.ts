import { createHash } from "node:crypto";

export type ClickUpAssetTargetKind = "leads" | "tasks" | "knowledge";

export function clickUpAssetFinalPath(input: {
  organizationId: string;
  workspaceId: string;
  targetKind: ClickUpAssetTargetKind;
  targetId: string;
  sha256: string;
  extension: string;
}) {
  const workspaceHash = createHash("sha256").update(input.workspaceId).digest("hex").slice(0, 32);
  return `${input.organizationId}/${workspaceHash}/${input.targetKind}/${input.targetId}/${input.sha256}.${input.extension}`;
}

/** Validação fechada antes de qualquer download com service role. */
export function isClickUpAssetFinalPathOwnedBy(
  path: string,
  organizationId: string,
  targetKind: ClickUpAssetTargetKind,
  targetId: string,
) {
  const parts = path.split("/");
  if (parts.length !== 5) return false;
  const [org, workspaceHash, kind, target, file] = parts;
  return (
    org === organizationId &&
    /^[0-9a-f]{32}$/.test(workspaceHash ?? "") &&
    kind === targetKind &&
    target === targetId &&
    /^[0-9a-f]{64}\.(?:pdf|txt|md|csv|png|jpg|gif|webp)$/.test(file ?? "")
  );
}
