import { describe, expect, it } from "vitest";

import { clickupSidecarSchema } from "./sidecar-contrato";

const base = {
  sidecar_version: 1,
  manifest_version: 3,
  run_id: "00000000-0000-4000-8000-000000000001",
  workspace_id: "wk-1",
  snapshot_hash: "a".repeat(64),
  coverage: {
    tasks_expected: 1_983,
    tasks_comments_scanned: 1_983,
    attachment_parents_scanned: 2_033,
    terminal_cursors: [
      { kind: "tasks", cursor: null, terminal: true },
      { kind: "task_comments", cursor: null, terminal: true },
      { kind: "doc_pages", cursor: null, terminal: true },
    ],
    comments_found: 1,
    replies_found: 0,
    assets_found: 1,
    bytes_declared: 4,
    bytes_downloaded: 0,
    warnings: [],
    skips: [],
  },
  comments: [
    {
      comment_id: "comment-1",
      task_id: "task-1",
      parent_comment_id: null,
      source_created_at: "2026-11-02T12:00:00.000Z",
      source_updated_at: null,
      author: { source_user_id: "user-1", display_name: "Pessoa" },
      body_markdown: "Confira [a referência](https://example.com).",
      attachment_ids: ["att-1"],
    },
  ],
  checkpoint: {
    parent_type: "task",
    parent_external_id: "task-1983",
    cursor: null,
    terminal: true,
  },
} as const;

describe("sidecar ClickUp v1", () => {
  it("aceita inventário sem blob e full com referência opaca", () => {
    expect(
      clickupSidecarSchema.parse({
        ...base,
        mode: "inventory",
        assets: [
          {
            attachment_id: "att-1",
            parent_type: "task",
            parent_external_id: "task-1",
            comment_id: null,
            file_name: "proposta.pdf",
            declared_size: 4,
            sniffed_mime: null,
            sha256: null,
            blob_ref: null,
            source_revision: "rev-1",
          },
        ],
      }).mode,
    ).toBe("inventory");

    expect(
      clickupSidecarSchema.parse({
        ...base,
        mode: "full",
        coverage: { ...base.coverage, bytes_downloaded: 4 },
        assets: [
          {
            attachment_id: "att-1",
            parent_type: "task",
            parent_external_id: "task-1",
            comment_id: null,
            file_name: "proposta.pdf",
            declared_size: 4,
            sniffed_mime: "application/pdf",
            sha256: "b".repeat(64),
            blob_ref: "blobs/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.pdf",
            source_revision: "rev-1",
          },
        ],
      }).mode,
    ).toBe("full");
  });

  it("recusa URL/token/e-mail, contagem divergente e blob no inventário", () => {
    const asset = {
      attachment_id: "att-1",
      parent_type: "task",
      parent_external_id: "task-1",
      comment_id: null,
      file_name: "https://signed.example/file.pdf",
      declared_size: 4,
      sniffed_mime: null,
      sha256: null,
      blob_ref: null,
      source_revision: "rev-1",
    };
    expect(
      clickupSidecarSchema.safeParse({
        ...base,
        mode: "inventory",
        coverage: { ...base.coverage, assets_found: 2 },
        assets: [asset],
      }).success,
    ).toBe(false);
    expect(
      clickupSidecarSchema.safeParse({
        ...base,
        mode: "inventory",
        assets: [{ ...asset, file_name: "arquivo.pdf", blob_ref: "quarantine/x" }],
      }).success,
    ).toBe(false);
    expect(
      clickupSidecarSchema.safeParse({
        ...base,
        mode: "inventory",
        comments: [
          {
            ...base.comments[0],
            body_markdown: "https://host/file?X-Amz-Signature=segredo",
          },
        ],
        assets: [{ ...asset, file_name: "arquivo.pdf" }],
      }).success,
    ).toBe(false);
  });

  it("recusa identidades duplicadas e blob_ref que não corresponde ao sha256", () => {
    const asset = {
      attachment_id: "att-1",
      parent_type: "task" as const,
      parent_external_id: "task-1",
      comment_id: null,
      file_name: "arquivo.pdf",
      declared_size: 4,
      sniffed_mime: "application/pdf",
      sha256: "b".repeat(64),
      blob_ref: `blobs/${"c".repeat(64)}.pdf`,
      source_revision: "rev-1",
    };
    expect(
      clickupSidecarSchema.safeParse({
        ...base,
        mode: "full",
        coverage: { ...base.coverage, assets_found: 2, bytes_declared: 8, bytes_downloaded: 8 },
        assets: [asset, asset],
      }).success,
    ).toBe(false);
  });

  it("prende comment_id à mesma Task e proíbe comentário em asset de Doc", () => {
    const asset = {
      attachment_id: "att-1",
      parent_type: "task" as const,
      parent_external_id: "task-1",
      comment_id: "comment-1",
      file_name: "arquivo.pdf",
      declared_size: 4,
      sniffed_mime: null,
      sha256: null,
      blob_ref: null,
      source_revision: "rev-1",
    };
    expect(
      clickupSidecarSchema.safeParse({ ...base, mode: "inventory", assets: [asset] }).success,
    ).toBe(true);
    expect(
      clickupSidecarSchema.safeParse({
        ...base,
        mode: "inventory",
        assets: [{ ...asset, parent_external_id: "task-alheia" }],
      }).success,
    ).toBe(false);
    expect(
      clickupSidecarSchema.safeParse({
        ...base,
        mode: "inventory",
        assets: [{ ...asset, parent_type: "doc_page", parent_external_id: "page-1" }],
      }).success,
    ).toBe(false);
  });
});
