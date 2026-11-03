import { describe, expect, it, vi } from "vitest";

import {
  claimClickUpAsset,
  claimClickUpItemForProcessor,
  claimClickUpRunForProcessor,
} from "./store";

describe("store do ClickUp", () => {
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
