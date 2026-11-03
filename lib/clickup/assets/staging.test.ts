import { describe, expect, it } from "vitest";

import { clickupSidecarSchema } from "@/lib/clickup/sidecar-contrato";

import { assertCompleteClickUpFullCoverage, resolveClickUpSidecarBlobReceipts } from "./staging";

const SHA = "b".repeat(64);
const BLOB_REF = `blobs/${SHA}.pdf`;
const UPLOAD_ID = "00000000-0000-4000-8000-000000000099";

const full = clickupSidecarSchema.parse({
  sidecar_version: 1,
  manifest_version: 3,
  run_id: "00000000-0000-4000-8000-000000000001",
  workspace_id: "wk-1",
  snapshot_hash: "a".repeat(64),
  mode: "full",
  coverage: {
    tasks_expected: 1,
    tasks_comments_scanned: 1,
    attachment_parents_scanned: 1,
    terminal_cursors: [{ kind: "tasks", cursor: null, terminal: true }],
    comments_found: 0,
    replies_found: 0,
    assets_found: 1,
    bytes_declared: 4,
    bytes_downloaded: 4,
    warnings: [],
    skips: [],
  },
  comments: [],
  assets: [
    {
      attachment_id: "attachment-1",
      parent_type: "task",
      parent_external_id: "task-1",
      comment_id: null,
      file_name: "arquivo.pdf",
      declared_size: 4,
      sniffed_mime: "application/pdf",
      sha256: SHA,
      blob_ref: BLOB_REF,
      source_revision: "rev-1",
    },
  ],
  checkpoint: {
    parent_type: "task",
    parent_external_id: "task-1",
    cursor: null,
    terminal: true,
  },
});

describe("staging do sidecar full", () => {
  it("resolve blob_ref portátil para receipt UUID sem expor path final", () => {
    const staged = resolveClickUpSidecarBlobReceipts(full, [
      { attachment_id: "attachment-1", blob_ref: BLOB_REF, upload_id: UPLOAD_ID },
    ]);
    expect(staged.assets[0]?.blob_ref).toBe(UPLOAD_ID);
    expect(JSON.stringify(staged)).not.toContain("quarantine/");
  });

  it("recusa receipt ausente, duplicado ou alheio", () => {
    expect(() => resolveClickUpSidecarBlobReceipts(full, [])).toThrow(
      "clickup_asset_upload_receipt_required",
    );
    expect(() =>
      resolveClickUpSidecarBlobReceipts(full, [
        { attachment_id: "attachment-1", blob_ref: BLOB_REF, upload_id: UPLOAD_ID },
        { attachment_id: "attachment-1", blob_ref: BLOB_REF, upload_id: UPLOAD_ID },
      ]),
    ).toThrow("clickup_asset_upload_receipt_duplicate");
    expect(() =>
      resolveClickUpSidecarBlobReceipts(full, [
        { attachment_id: "estranho", blob_ref: "blobs/estranho.pdf", upload_id: UPLOAD_ID },
      ]),
    ).toThrow("clickup_asset_upload_receipt_unexpected");
  });

  it("compara coverage full ao conjunto real de Tasks staged", () => {
    const covered = {
      ...full,
      coverage: {
        ...full.coverage,
        terminal_cursors: [
          {
            kind: "tasks" as const,
            parent_external_id: "task-1",
            cursor: null,
            terminal: true as const,
          },
          {
            kind: "task_comments" as const,
            parent_external_id: "task-1",
            cursor: null,
            terminal: true as const,
          },
        ],
      },
    };
    expect(() => assertCompleteClickUpFullCoverage(covered, ["task-1"])).not.toThrow();
    expect(() => assertCompleteClickUpFullCoverage(covered, ["task-2"])).toThrow(
      "clickup_sidecar_incomplete_coverage",
    );
  });

  it("conta páginas de Docs terminais como pais de anexos além das Tasks", () => {
    const covered = {
      ...full,
      coverage: {
        ...full.coverage,
        attachment_parents_scanned: 2,
        terminal_cursors: [
          {
            kind: "tasks" as const,
            parent_external_id: "task-1",
            cursor: null,
            terminal: true as const,
          },
          {
            kind: "task_comments" as const,
            parent_external_id: "task-1",
            cursor: null,
            terminal: true as const,
          },
          {
            kind: "doc_pages" as const,
            parent_external_id: "page-1",
            cursor: null,
            terminal: true as const,
          },
        ],
      },
    };
    expect(() => assertCompleteClickUpFullCoverage(covered, ["task-1"], ["page-1"])).not.toThrow();
    expect(() =>
      assertCompleteClickUpFullCoverage(
        { ...covered, coverage: { ...covered.coverage, attachment_parents_scanned: 1 } },
        ["task-1"],
        ["page-1"],
      ),
    ).toThrow("clickup_sidecar_incomplete_coverage");
    expect(() => assertCompleteClickUpFullCoverage(covered, ["task-1"], [])).toThrow(
      "clickup_sidecar_incomplete_coverage",
    );
    expect(() => assertCompleteClickUpFullCoverage(covered, ["task-1"], ["page-2"])).toThrow(
      "clickup_sidecar_incomplete_coverage",
    );
  });
});
