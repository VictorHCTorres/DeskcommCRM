import type { ClickUpManifestInput } from "../lib/clickup/contrato";

export interface ClickUpCrmBundleV3Options {
  backup: string;
  connectionId: string;
  workspaceId?: string;
  out?: string;
}

export function exportarClickUpCrmBundleV3(
  options: ClickUpCrmBundleV3Options,
): Promise<ClickUpManifestInput>;
