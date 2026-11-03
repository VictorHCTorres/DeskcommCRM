import { describe, expect, it, vi } from "vitest";

import {
  CLICKUP_STAGE_BATCH_MAX_BYTES,
  CLICKUP_STAGE_BATCH_MAX_ROWS,
  CLICKUP_STAGE_MAX_SINGLE_ROW_BYTES,
  claimClickUpAsset,
  claimClickUpItemForProcessor,
  claimClickUpRunForProcessor,
  splitClickUpStagingRows,
  stageClickUpPreview,
} from "./store";

function clickupManifest(taskCount: number) {
  return {
    connection_id: "00000000-0000-4000-8000-000000000010",
    workspace_id: "workspace-1",
    source: "api" as const,
    scope: "crm" as const,
    manifest_version: 3,
    objects: Array.from({ length: taskCount }, (_, index) => ({
      source_type: "task" as const,
      source_id: `task-${index}`,
      metadata: { name: `Tarefa ${index}` },
      content_access: "none" as const,
    })),
  };
}

function stagingDb(options: { failItemsAt?: number } = {}) {
  const itemBatches: unknown[][] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "fn_begin_clickup_import_preview") {
      run = { id: args.p_run_id };
      return { data: args.p_run_id, error: null };
    }
    if (name === "fn_append_clickup_import_preview_items") {
      const value = args.p_items as unknown[];
      itemBatches.push(value);
      const failed = options.failItemsAt === itemBatches.length;
      return {
        data: failed ? null : value.length,
        error: failed ? { code: "57014", message: "statement timeout" } : null,
      };
    }
    if (name === "fn_finalize_clickup_import_preview") {
      return { data: args.p_run_id, error: null };
    }
    if (name === "fn_abort_clickup_import_preview") return { data: true, error: null };
    throw new Error(`RPC inesperada: ${name}`);
  });
  let run: Record<string, unknown> | null = null;
  const chain = (result: () => unknown) => {
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = () => builder;
    builder.maybeSingle = async () => ({ data: result(), error: null });
    return builder;
  };
  const from = vi.fn((table: string) => {
    if (table === "clickup_connections") {
      return chain(() => ({ id: "00000000-0000-4000-8000-000000000010" }));
    }
    if (table === "clickup_import_runs") {
      return chain(() => run);
    }
    throw new Error(`Tabela inesperada: ${table}`);
  });
  return { db: { from, rpc } as never, from, rpc, itemBatches };
}

describe("store do ClickUp", () => {
  it("divide a prévia volumosa por quantidade e bytes sem perder nem reordenar itens", () => {
    const rows = Array.from({ length: 2_200 }, (_, index) => ({
      entity_type: "task" as const,
      external_id: `task-${index}`,
      parent_external_id: null,
      source_revision: null,
      source_hash: "a".repeat(64),
      source_metadata: { description: `${index}:`.padEnd(7_000, String(index % 10)) },
      source_payload: null,
      payload_expires_at: null,
      content_access: "none" as const,
      status: "ready" as const,
      execution_blocked: false,
      blocked_reason: null,
    }));

    const batches = splitClickUpStagingRows(rows);

    expect(batches.length).toBeGreaterThan(22);
    expect(batches.flat().map((row) => row.external_id)).toEqual(
      rows.map((row) => row.external_id),
    );
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(CLICKUP_STAGE_BATCH_MAX_ROWS);
      expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBeLessThanOrEqual(
        CLICKUP_STAGE_BATCH_MAX_BYTES,
      );
    }
  });

  it("divide o corpo de 501 KiB que atingiu o timeout em produção", () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      entity_type: "task" as const,
      external_id: `production-timeout-${index}`,
      parent_external_id: null,
      source_revision: null,
      source_hash: "a".repeat(64),
      source_metadata: { description: "x".repeat(45_000) },
      source_payload: null,
      payload_expires_at: null,
      content_access: "none" as const,
      status: "ready" as const,
      execution_blocked: false,
      blocked_reason: null,
    }));

    expect(Buffer.byteLength(JSON.stringify(rows), "utf8")).toBeGreaterThan(501 * 1024);
    const batches = splitClickUpStagingRows(rows);
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches) {
      expect(Buffer.byteLength(JSON.stringify(batch), "utf8")).toBeLessThanOrEqual(
        CLICKUP_STAGE_BATCH_MAX_BYTES,
      );
    }
  });

  it("recusa uma linha individual acima do teto configurado sem truncar conteúdo", () => {
    const oversized = {
      entity_type: "task" as const,
      external_id: "task-oversized",
      parent_external_id: null,
      source_revision: null,
      source_hash: "a".repeat(64),
      source_metadata: { description: "x".repeat(1_024) },
      source_payload: null,
      payload_expires_at: null,
      content_access: "none" as const,
      status: "ready" as const,
      execution_blocked: false,
      blocked_reason: null,
    };

    expect(() =>
      splitClickUpStagingRows([oversized], { maxRows: 10, maxBytes: 100 }),
    ).toThrow(/task-oversized/);
  });

  it("recusa uma única linha grande demais antes de abrir a prévia", () => {
    const oversized = {
      entity_type: "task" as const,
      external_id: "task-too-large",
      parent_external_id: null,
      source_revision: null,
      source_hash: "a".repeat(64),
      source_metadata: { description: "x".repeat(CLICKUP_STAGE_MAX_SINGLE_ROW_BYTES + 1) },
      source_payload: null,
      payload_expires_at: null,
      content_access: "none" as const,
      status: "ready" as const,
      execution_blocked: false,
      blocked_reason: null,
    };

    expect(() => splitClickUpStagingRows([oversized])).toThrow(/task-too-large/);
  });

  it("grava a prévia em vários inserts e só então a finaliza", async () => {
    const fake = stagingDb();

    const run = await stageClickUpPreview(fake.db, {
      organizationId: "00000000-0000-4000-8000-000000000001",
      userId: "00000000-0000-4000-8000-000000000002",
      manifest: clickupManifest(205),
    });

    expect(run.id).toEqual(expect.any(String));
    expect(fake.itemBatches.map((batch) => batch.length)).toEqual([
      25, 25, 25, 25, 25, 25, 25, 25, 5,
    ]);
    expect(fake.rpc).toHaveBeenCalledTimes(11);
    expect(fake.rpc).toHaveBeenCalledWith(
      "fn_finalize_clickup_import_preview",
      expect.objectContaining({ p_expected_items: 205 }),
    );
  });

  it("aborta e remove o rascunho quando um lote falha", async () => {
    const fake = stagingDb({ failItemsAt: 2 });

    await expect(
      stageClickUpPreview(fake.db, {
        organizationId: "00000000-0000-4000-8000-000000000001",
        userId: "00000000-0000-4000-8000-000000000002",
        manifest: clickupManifest(205),
      }),
    ).rejects.toMatchObject({ code: "database_error" });
    expect(fake.rpc).toHaveBeenCalledTimes(4);
    expect(fake.rpc).toHaveBeenCalledWith(
      "fn_abort_clickup_import_preview",
      expect.objectContaining({ p_run_id: expect.any(String) }),
    );
  });

  it("trata composite SQL sem linha como ausência de run", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: null, organization_id: null, lease_token: null },
      error: null,
    });

    await expect(
      claimClickUpRunForProcessor({ rpc } as never, "00000000-0000-4000-8000-000000000001", "crm"),
    ).resolves.toBeNull();
  });

  it("trata composite SQL sem linha como ausência de anexo", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: null, organization_id: null, claim_token: null },
      error: null,
    });

    await expect(
      claimClickUpAsset({ rpc } as never, "00000000-0000-4000-8000-000000000001"),
    ).resolves.toBeNull();
  });

  it("trata composite SQL sem linha como ausência de item", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: { id: null, organization_id: null, claim_token: null },
      error: null,
    });

    await expect(
      claimClickUpItemForProcessor(
        { rpc } as never,
        "00000000-0000-4000-8000-000000000001",
        "00000000-0000-4000-8000-000000000002",
        "crm",
      ),
    ).resolves.toBeNull();
  });

  it("preserva composites reivindicados que têm identidade", async () => {
    const run = { id: "run-1", organization_id: "org-1", lease_token: "lease-1" };
    const asset = { id: "asset-1", organization_id: "org-1", claim_token: "claim-1" };
    const item = { id: "item-1", organization_id: "org-1", claim_token: "claim-1" };
    const rpc = vi
      .fn()
      .mockResolvedValueOnce({ data: run, error: null })
      .mockResolvedValueOnce({ data: item, error: null })
      .mockResolvedValueOnce({ data: asset, error: null });
    const db = { rpc } as never;

    await expect(
      claimClickUpRunForProcessor(db, "00000000-0000-4000-8000-000000000001", "docs"),
    ).resolves.toEqual(run);
    await expect(claimClickUpItemForProcessor(db, "org-1", "run-1", "docs")).resolves.toEqual(item);
    await expect(claimClickUpAsset(db, "00000000-0000-4000-8000-000000000001")).resolves.toEqual(
      asset,
    );
  });
});
