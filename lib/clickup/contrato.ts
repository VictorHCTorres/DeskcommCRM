import { z } from "zod";

import { clickupCrmMappingConfigSchema } from "@/lib/clickup/crm/contrato";

export const clickupSourceTypeSchema = z.enum([
  "workspace",
  "space",
  "folder",
  "list",
  "task",
  "doc",
  "doc_page",
  "user",
  "status",
  "custom_field",
]);

export type ClickUpSourceType = z.infer<typeof clickupSourceTypeSchema>;

export const clickupContentAccessSchema = z.enum(["none", "metadata_only", "full"]);

const jsonRecordSchema = z.record(z.string(), z.unknown());
const clickupDocumentPayloadSchema = z
  .object({
    format: z.literal("markdown"),
    content: z.string().trim().min(1),
  })
  .strict();

export const clickupDiscoveredObjectSchema = z
  .object({
    source_type: clickupSourceTypeSchema,
    source_id: z.string().trim().min(1).max(512),
    parent_source_id: z.string().trim().min(1).max(512).nullable().optional(),
    source_revision: z.string().trim().min(1).max(512).nullable().optional(),
    metadata: jsonRecordSchema.default({}),
    /** Somente staging service-role; nunca integra a projeção pública do item. */
    payload: z.unknown().optional(),
    content_access: clickupContentAccessSchema.default("none"),
  })
  .strict()
  .superRefine((object, context) => {
    const isDocument = object.source_type === "doc" || object.source_type === "doc_page";
    if (!isDocument && object.content_access !== "none") {
      context.addIssue({
        code: "custom",
        path: ["content_access"],
        message: "content_access só se aplica a Docs.",
      });
      return;
    }
    if (!isDocument) return;
    if (object.content_access === "full") {
      const payload = clickupDocumentPayloadSchema.safeParse(object.payload);
      if (!payload.success) {
        context.addIssue({
          code: "custom",
          path: ["payload"],
          message: "Docs com acesso full exigem payload estruturado e conteúdo não vazio.",
        });
      }
      return;
    }
    if (object.payload !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Metadados de Docs sem autorização não podem carregar conteúdo.",
      });
    }
  });

export const clickupManifestSchema = z
  .object({
    connection_id: z.string().uuid(),
    workspace_id: z.string().trim().min(1).max(255),
    source: z.enum(["api", "bundle"]).default("api"),
    scope: z.enum(["crm", "docs", "all"]).default("crm"),
    manifest_version: z.number().int().positive().default(1),
    source_revision: z.string().trim().min(1).max(512).nullable().optional(),
    objects: z.array(clickupDiscoveredObjectSchema).max(5_000),
  })
  .strict();

export const clickupConnectionCreateSchema = z
  .object({
    workspace_id: z.string().trim().min(1).max(255),
    workspace_name: z.string().trim().min(1).max(255),
    token: z.string().trim().min(8).max(4_096),
  })
  .strict();

export const clickupDiscoverySchema = z.object({ connection_id: z.string().uuid() }).strict();

const clickupTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pipeline_group"), pipeline_group_id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("pipeline"), pipeline_id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("stage"), stage_id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("lead"), lead_id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("task"), task_id: z.string().uuid() }).strict(),
  z
    .object({ kind: z.literal("knowledge_source"), knowledge_source_id: z.string().uuid() })
    .strict(),
  z
    .object({
      kind: z.literal("custom_field"),
      pipeline_id: z.string().uuid(),
      field_key: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/),
    })
    .strict(),
]);

const clickupMappingConfigSchema = z
  .object({
    objects: z
      .array(
        z
          .object({
            entity_type: clickupSourceTypeSchema,
            external_id: z.string().trim().min(1).max(512),
            target: clickupTargetSchema,
          })
          .strict()
          .superRefine((entry, context) => {
            const kind = entry.target.kind;
            const valid =
              ((entry.entity_type === "workspace" ||
                entry.entity_type === "space" ||
                entry.entity_type === "folder") &&
                kind === "pipeline_group") ||
              (entry.entity_type === "list" && kind === "pipeline") ||
              (entry.entity_type === "status" && kind === "stage") ||
              (entry.entity_type === "task" && (kind === "lead" || kind === "task")) ||
              ((entry.entity_type === "doc" || entry.entity_type === "doc_page") &&
                kind === "knowledge_source") ||
              (entry.entity_type === "custom_field" && kind === "custom_field");
            if (!valid) {
              context.addIssue({
                code: "custom",
                path: ["target"],
                message: "O alvo não é compatível com o tipo de entidade ClickUp.",
              });
            }
          }),
      )
      .max(5_000)
      .default([]),
    crm: clickupCrmMappingConfigSchema.optional(),
  })
  .strict();

export const clickupMappingSchema = z
  .object({
    expected_revision: z.number().int().min(0),
    mapping: clickupMappingConfigSchema,
  })
  .strict();

export const clickupExecuteSchema = z
  .object({
    dry_run: z.boolean().default(true),
    expected_preview_revision: z.number().int().positive(),
    expected_snapshot_hash: z.string().regex(/^[0-9a-f]{64}$/),
    expected_mapping_hash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .nullable(),
  })
  .strict()
  .superRefine((input, context) => {
    if (!input.dry_run && !input.expected_mapping_hash) {
      context.addIssue({
        code: "custom",
        path: ["expected_mapping_hash"],
        message: "Execução real exige mapping validado.",
      });
    }
  });

export const clickupRunIdSchema = z.string().uuid();

export type ClickUpManifestInput = z.input<typeof clickupManifestSchema>;
export type ClickUpManifest = z.output<typeof clickupManifestSchema>;
export type ClickUpDiscoveredObject = z.output<typeof clickupDiscoveredObjectSchema>;

export const CLICKUP_DOC_CONTENT_BLOCK_REASON = "clickup_doc_content_not_authorized";
export const CLICKUP_ENVELOPE_SCHEMA_VERSION = 1 as const;

export function clickupConnectionReceiptIdentity(
  input: {
    workspace_id: string;
    workspace_name: string;
  },
  tokenFingerprint: string,
) {
  return {
    workspace_id: input.workspace_id,
    workspace_name: input.workspace_name,
    token_fingerprint: tokenFingerprint,
  };
}

export function blockForMissingDocumentContent(object: ClickUpDiscoveredObject): {
  execution_blocked: boolean;
  blocked_reason: string | null;
} {
  const isDocument = object.source_type === "doc" || object.source_type === "doc_page";
  if (isDocument && object.content_access !== "full") {
    return {
      execution_blocked: true,
      blocked_reason: CLICKUP_DOC_CONTENT_BLOCK_REASON,
    };
  }
  return { execution_blocked: false, blocked_reason: null };
}
