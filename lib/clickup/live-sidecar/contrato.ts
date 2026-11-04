import { z } from "zod";

import {
  clickupSidecarAssetSchema,
  clickupSidecarCommentSchema,
} from "@/lib/clickup/sidecar-contrato";

const receipt = z
  .object({
    attachment_id: z.string().trim().min(1).max(512),
    blob_ref: z.string().trim().min(1).max(1_024),
    upload_id: z.string().uuid(),
  })
  .strict();

/** Fragmento persistível: nunca contém token, URL de origem nem URL assinada. */
export const clickupLiveParentResultSchema = z
  .object({
    comments: z.array(clickupSidecarCommentSchema).max(5_000),
    assets: z.array(clickupSidecarAssetSchema).max(20),
    blob_receipts: z.array(receipt).max(20),
    comments_terminal: z.literal(true),
    assets_terminal: z.literal(true),
    replies_found: z.number().int().min(0),
    bytes_downloaded: z.number().int().min(0),
    warnings: z
      .array(
        z
          .object({
            code: z.string().trim().min(1).max(100),
            attachment_id: z.string().trim().min(1).max(512).optional(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((result, context) => {
    const serialized = JSON.stringify(result);
    if (
      /(?:authorization|x-amz-(?:signature|credential)|[?&](?:token|sig|signature)=)/i.test(
        serialized,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Fragmento live não pode persistir URL ou segredo assinado.",
      });
    }
    if (result.blob_receipts.length !== (result.assets[0]?.sha256 ? result.assets.length : 0)) {
      context.addIssue({
        code: "custom",
        path: ["blob_receipts"],
        message: "Receipts incompletos.",
      });
    }
  });

export type ClickUpLiveParentResult = z.output<typeof clickupLiveParentResultSchema>;
