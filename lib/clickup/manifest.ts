import { createHash } from "node:crypto";

import {
  blockForMissingDocumentContent,
  clickupManifestSchema,
  type ClickUpDiscoveredObject,
  type ClickUpManifest,
  type ClickUpManifestInput,
} from "@/lib/clickup/contrato";

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function clickupHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalizeClickUpManifest(input: ClickUpManifestInput): ClickUpManifest {
  const parsed = clickupManifestSchema.parse(input);
  return {
    ...parsed,
    objects: [...parsed.objects].sort((a, b) => {
      const typeOrder = a.source_type.localeCompare(b.source_type);
      return typeOrder || a.source_id.localeCompare(b.source_id);
    }),
  };
}

export function manifestHash(manifest: ClickUpManifest): string {
  return clickupHash(manifest);
}

export function discoveredObjectToStaging(object: ClickUpDiscoveredObject, now = new Date()) {
  const block = blockForMissingDocumentContent(object);
  const hasPayload = object.payload !== undefined;
  return {
    entity_type: object.source_type,
    external_id: object.source_id,
    parent_external_id: object.parent_source_id ?? null,
    source_revision: object.source_revision ?? null,
    source_hash: clickupHash(
      object.source_type === "task_relation"
        ? {
            source_type: object.source_type,
            source_id: object.source_id,
            relation_type: object.metadata.relation_type,
            source_task_id: object.metadata.source_task_id,
            target_task_id: object.metadata.target_task_id,
          }
        : {
            source_type: object.source_type,
            source_id: object.source_id,
            source_revision: object.source_revision ?? null,
            metadata: object.metadata,
            payload: object.payload,
          },
    ),
    source_metadata: object.metadata,
    source_payload: hasPayload ? object.payload : null,
    payload_expires_at: hasPayload
      ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1_000).toISOString()
      : null,
    content_access: object.content_access,
    status: block.execution_blocked ? "blocked" : "ready",
    ...block,
  };
}
