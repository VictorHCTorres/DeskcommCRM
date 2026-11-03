import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { applyClickUpAsset } from "./aplicar";

describe("apply ClickUp asset", () => {
  it("enfileira o blob final órfão quando cancelamento vence depois do upload", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nasset");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const quarantine = `quarantine/org/run/${"a".repeat(64)}/upload/${sha}`;
    const rpc = vi.fn(async (name: string) => {
      if (name === "fn_commit_clickup_asset") {
        return { data: null, error: { message: "clickup_asset_lease_lost" } };
      }
      if (name === "fn_queue_clickup_asset_orphan") return { data: true, error: null };
      throw new Error(`rpc inesperada: ${name}`);
    });
    const remove = vi.fn(async () => ({ data: [], error: null }));
    const queries: Record<string, unknown> = {
      clickup_asset_uploads: {
        id: "44444444-4444-4444-8444-444444444444",
        storage_path: quarantine,
        sha256: sha,
        declared_size: bytes.byteLength,
        state: "uploaded",
        expires_at: "2026-11-04T00:00:00Z",
      },
      clickup_asset_receipts: null,
      clickup_object_mappings: {
        lead_id: null,
        task_id: "33333333-3333-4333-8333-333333333333",
        knowledge_source_id: null,
      },
    };
    const db = {
      from(table: string) {
        const query = {
          select: () => query,
          eq: () => query,
          maybeSingle: async () => ({ data: queries[table] ?? null, error: null }),
        };
        return query;
      },
      rpc,
      storage: {
        from: () => ({
          download: async () => ({ data: new Blob([bytes]), error: null }),
          upload: async () => ({ data: {}, error: null }),
          remove,
        }),
      },
    } as unknown as SupabaseClient;

    await expect(
      applyClickUpAsset(db, {
        id: "55555555-5555-4555-8555-555555555555",
        claim_token: "66666666-6666-4666-8666-666666666666",
        organization_id: "11111111-1111-4111-8111-111111111111",
        run_id: "22222222-2222-4222-8222-222222222222",
        workspace_id: "wk-1",
        attachment_id: "asset-1",
        parent_type: "task",
        parent_external_id: "task-source",
        comment_id: null,
        file_name: "arquivo.pdf",
        declared_size: bytes.byteLength,
        sniffed_mime: "application/pdf",
        source_sha256: sha,
        source_revision: "rev-1",
        upload_id: "44444444-4444-4444-8444-444444444444",
      }),
    ).rejects.toThrow("clickup_asset_atomic_commit:clickup_asset_lease_lost");
    expect(rpc.mock.calls.map(([name]) => name)).toEqual([
      "fn_commit_clickup_asset",
      "fn_queue_clickup_asset_orphan",
    ]);
    expect(remove).not.toHaveBeenCalled();

    rpc.mockImplementation(async (name: string) =>
      name === "fn_commit_clickup_asset"
        ? { data: null, error: { message: "clickup_asset_lease_lost" } }
        : { data: null, error: { message: "database_unavailable" } },
    );
    await expect(
      applyClickUpAsset(db, {
        id: "55555555-5555-4555-8555-555555555555",
        claim_token: "66666666-6666-4666-8666-666666666666",
        organization_id: "11111111-1111-4111-8111-111111111111",
        run_id: "22222222-2222-4222-8222-222222222222",
        workspace_id: "wk-1",
        attachment_id: "asset-1",
        parent_type: "task",
        parent_external_id: "task-source",
        comment_id: null,
        file_name: "arquivo.pdf",
        declared_size: bytes.byteLength,
        sniffed_mime: "application/pdf",
        source_sha256: sha,
        source_revision: "rev-1",
        upload_id: "44444444-4444-4444-8444-444444444444",
      }),
    ).rejects.toThrow("clickup_asset_orphan_cleanup_failed:database_unavailable");
  });

  it("preserva promoted quando cleanup pós-commit falha e deixa recovery durável", async () => {
    const bytes = new TextEncoder().encode("%PDF-1.7\nasset");
    const sha = createHash("sha256").update(bytes).digest("hex");
    const upload = {
      id: "44444444-4444-4444-8444-444444444444",
      storage_path: `quarantine/org/run/${"a".repeat(64)}/upload/${sha}`,
      sha256: sha,
      declared_size: bytes.byteLength,
      state: "uploaded",
      expires_at: "2026-11-04T00:00:00Z",
    };
    const rpc = vi.fn(async (name: string) => {
      if (name === "fn_commit_clickup_asset") {
        return { data: { result: "promoted" }, error: null };
      }
      throw new Error(`cleanup RPC não deveria rodar após falha do UPDATE: ${name}`);
    });
    const remove = vi.fn();
    const db = {
      from(table: string) {
        let updating = false;
        const query = {
          select: () => query,
          update: () => {
            updating = true;
            return query;
          },
          eq: () => query,
          maybeSingle: async () => ({
            data:
              table === "clickup_asset_uploads"
                ? upload
                : table === "clickup_object_mappings"
                  ? {
                      lead_id: null,
                      task_id: "33333333-3333-4333-8333-333333333333",
                      knowledge_source_id: null,
                    }
                  : null,
            error: null,
          }),
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: null,
              error: updating ? { message: "database_unavailable" } : null,
            }).then(resolve),
        };
        return query;
      },
      rpc,
      storage: {
        from: () => ({
          download: async () => ({ data: new Blob([bytes]), error: null }),
          upload: async () => ({ data: {}, error: null }),
          remove,
        }),
      },
    } as unknown as SupabaseClient;

    await expect(
      applyClickUpAsset(db, {
        id: "55555555-5555-4555-8555-555555555555",
        claim_token: "66666666-6666-4666-8666-666666666666",
        organization_id: "11111111-1111-4111-8111-111111111111",
        run_id: "22222222-2222-4222-8222-222222222222",
        workspace_id: "wk-1",
        attachment_id: "asset-1",
        parent_type: "task",
        parent_external_id: "task-source",
        comment_id: null,
        file_name: "arquivo.pdf",
        declared_size: bytes.byteLength,
        sniffed_mime: "application/pdf",
        source_sha256: sha,
        source_revision: "rev-1",
        upload_id: upload.id,
      }),
    ).resolves.toEqual({
      outcome: "promoted",
      finalPath: expect.stringMatching(/\/tasks\/33333333-3333-4333-8333-333333333333\//),
      errorCode: "clickup_asset_upload_consume_pending",
    });
    expect(remove).not.toHaveBeenCalled();
  });
});
