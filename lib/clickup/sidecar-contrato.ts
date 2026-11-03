import { z } from "zod";

/**
 * Contrato complementar ao manifesto ClickUp v3.
 *
 * O manifesto descreve entidades; o sidecar v1 prova a varredura dos anexos e
 * referencia blobs já recebidos em storage privado. URLs, tokens e dados de
 * identidade nunca atravessam esta fronteira.
 */
export const CLICKUP_SIDECAR_VERSION = 1 as const;
export const CLICKUP_SIDECAR_MANIFEST_VERSION = 3 as const;

export const CLICKUP_ASSET_MAX_BYTES = 10 * 1024 * 1024;
export const CLICKUP_SIDECAR_MAX_BYTES = 100 * 1024 * 1024;
export const CLICKUP_ASSET_MAX_PER_TARGET = 20;
export const CLICKUP_ASSET_MAX_BYTES_PER_TARGET = 50 * 1024 * 1024;

const id = z.string().trim().min(1).max(512);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const parentType = z.enum(["task", "doc_page"]);
const safeBlobRef = z
  .string()
  .trim()
  .min(1)
  .max(1_024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine((value) => !value.includes("..") && !value.includes("//"), "blob_ref inseguro");
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

const assetBase = z
  .object({
    attachment_id: id,
    parent_type: parentType,
    parent_external_id: id,
    comment_id: id.nullable().optional(),
    file_name: z.string().trim().min(1).max(255),
    declared_size: z.number().int().min(0).max(CLICKUP_ASSET_MAX_BYTES).nullable(),
    source_revision: id.nullable(),
  })
  .strict();

const inventoryAsset = assetBase.extend({
  sniffed_mime: z.null(),
  sha256: z.null(),
  blob_ref: z.null(),
});

const fullAsset = assetBase
  .extend({
    sniffed_mime: z.string().trim().min(1).max(255),
    sha256,
    blob_ref: safeBlobRef,
  })
  .superRefine((asset, context) => {
    if (!asset.blob_ref.startsWith(`blobs/${asset.sha256}.`)) {
      context.addIssue({
        code: "custom",
        path: ["blob_ref"],
        message: "blob_ref não corresponde ao sha256 do asset.",
      });
    }
  });

export const clickupSidecarAssetSchema = z.union([inventoryAsset, fullAsset]);
export type ClickUpSidecarAsset = z.output<typeof clickupSidecarAssetSchema>;

export const clickupSidecarCommentSchema = z
  .object({
    comment_id: id,
    task_id: id,
    parent_comment_id: id.nullable(),
    source_created_at: z.iso.datetime({ offset: true }),
    source_updated_at: z.iso.datetime({ offset: true }).nullable(),
    author: z
      .object({
        source_user_id: id,
        display_name: z
          .string()
          .trim()
          .min(1)
          .max(255)
          .refine((value) => !email.test(value), "E-mail do autor não pode ser persistido."),
      })
      .strict(),
    body_markdown: z.string().max(100_000),
    attachment_ids: z.array(id).max(CLICKUP_ASSET_MAX_PER_TARGET),
  })
  .strict();

export type ClickUpSidecarComment = z.output<typeof clickupSidecarCommentSchema>;

const cursorTerminal = z
  .object({
    kind: z.enum(["tasks", "task_comments", "doc_pages"]),
    parent_external_id: id.nullable().optional(),
    cursor: z.null(),
    terminal: z.literal(true),
  })
  .strict();

export const clickupSidecarCoverageSchema = z
  .object({
    tasks_expected: z.number().int().min(0),
    tasks_comments_scanned: z.number().int().min(0),
    attachment_parents_scanned: z.number().int().min(0),
    terminal_cursors: z.array(cursorTerminal).min(1).max(10_000),
    comments_found: z.number().int().min(0),
    replies_found: z.number().int().min(0),
    assets_found: z.number().int().min(0),
    bytes_declared: z.number().int().min(0),
    bytes_downloaded: z.number().int().min(0),
    warnings: z
      .array(
        z
          .object({
            code: z.string().trim().min(1).max(100),
            parent_type: parentType.nullable().optional(),
            parent_external_id: id.nullable().optional(),
            attachment_id: id.nullable().optional(),
          })
          .strict(),
      )
      .max(5_000),
    skips: z
      .array(
        z
          .object({
            reason: z.string().trim().min(1).max(100),
            count: z.number().int().positive(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export const clickupSidecarCheckpointSchema = z
  .object({
    parent_type: parentType,
    parent_external_id: id,
    cursor: z.string().trim().min(1).max(1_024).nullable(),
    terminal: z.boolean(),
  })
  .strict();

const common = z
  .object({
    sidecar_version: z.literal(CLICKUP_SIDECAR_VERSION),
    manifest_version: z.literal(CLICKUP_SIDECAR_MANIFEST_VERSION),
    run_id: z.string().uuid(),
    workspace_id: z.string().trim().min(1).max(255),
    snapshot_hash: sha256,
    coverage: clickupSidecarCoverageSchema,
    checkpoint: clickupSidecarCheckpointSchema,
  })
  .strict();

const inventorySidecar = common.extend({
  mode: z.literal("inventory"),
  assets: z.array(inventoryAsset).max(50_000),
  comments: z.array(clickupSidecarCommentSchema).max(100_000),
});

const fullSidecar = common.extend({
  mode: z.literal("full"),
  assets: z.array(fullAsset).max(50_000),
  comments: z.array(clickupSidecarCommentSchema).max(100_000),
});

const SEGREDO_OU_URL_ASSINADA =
  /(?:x-amz-(?:signature|credential)|[?&](?:token|sig|signature)=|pk_[a-z0-9_-]{20,}|authorization:\s*bearer)/i;

export const clickupSidecarSchema = z
  .discriminatedUnion("mode", [inventorySidecar, fullSidecar])
  .superRefine((sidecar, context) => {
    if (
      new Set(sidecar.assets.map((asset) => asset.attachment_id)).size !== sidecar.assets.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["assets"],
        message: "attachment_id precisa ser único no sidecar.",
      });
    }
    if (
      new Set(sidecar.comments.map((comment) => comment.comment_id)).size !==
      sidecar.comments.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["comments"],
        message: "comment_id precisa ser único no sidecar.",
      });
    }
    const comments = new Map(sidecar.comments.map((comment) => [comment.comment_id, comment]));
    for (const [index, asset] of sidecar.assets.entries()) {
      if (asset.parent_type === "doc_page" && asset.comment_id) {
        context.addIssue({
          code: "custom",
          path: ["assets", index, "comment_id"],
          message: "Asset de Doc não pode apontar para comentário de Task.",
        });
      }
      if (asset.parent_type === "task" && asset.comment_id) {
        const comment = comments.get(asset.comment_id);
        if (
          !comment ||
          comment.task_id !== asset.parent_external_id ||
          !comment.attachment_ids.includes(asset.attachment_id)
        ) {
          context.addIssue({
            code: "custom",
            path: ["assets", index, "comment_id"],
            message: "O comentário do asset precisa pertencer à mesma Task e declarar o anexo.",
          });
        }
      }
    }
    if (sidecar.coverage.assets_found !== sidecar.assets.length) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "assets_found"],
        message: "assets_found deve corresponder aos assets do sidecar.",
      });
    }
    if (sidecar.coverage.comments_found !== sidecar.comments.length) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "comments_found"],
        message: "comments_found deve corresponder aos comentários do sidecar.",
      });
    }
    const replies = sidecar.comments.filter((comment) => comment.parent_comment_id !== null).length;
    if (sidecar.coverage.replies_found !== replies) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "replies_found"],
        message: "replies_found deve corresponder às replies do sidecar.",
      });
    }
    const bytes = sidecar.assets.reduce((total, asset) => total + (asset.declared_size ?? 0), 0);
    if (sidecar.coverage.bytes_declared !== bytes) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "bytes_declared"],
        message: "bytes_declared deve corresponder à soma declarada dos assets.",
      });
    }
    if (sidecar.mode === "full" && sidecar.coverage.bytes_downloaded !== bytes) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "bytes_downloaded"],
        message: "O sidecar full precisa comprovar todos os bytes declarados.",
      });
    }
    if (sidecar.coverage.tasks_comments_scanned > sidecar.coverage.tasks_expected) {
      context.addIssue({
        code: "custom",
        path: ["coverage", "tasks_comments_scanned"],
        message: "A cobertura de comentários excede o total esperado de Tasks.",
      });
    }
    const serialized = JSON.stringify(sidecar);
    if (SEGREDO_OU_URL_ASSINADA.test(serialized)) {
      context.addIssue({
        code: "custom",
        message: "O sidecar não pode conter token ou URL assinada.",
      });
    }
  });

export type ClickUpSidecar = z.output<typeof clickupSidecarSchema>;

/** O legado não prova varredura; nunca é promovido implicitamente para inventário vazio. */
export const CLICKUP_LEGACY_ATTACHMENT_COVERAGE = "unknown_not_exported" as const;
