import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clickUpAssetFinalPath } from "@/lib/clickup/assets/paths";

const ORG = "11111111-1111-4111-8111-111111111111";
const SOURCE = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => ({ row: null as Record<string, unknown> | null, download: vi.fn() }));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "user" },
    org: { orgId: ORG, role: "manager" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => {
    const query = {
      select: () => query,
      eq: () => query,
      maybeSingle: async () => ({ data: h.row, error: null }),
    };
    return { from: () => query } as unknown as SupabaseClient;
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    storage: { from: () => ({ download: h.download }) },
  })),
}));

import { GET } from "./route";

describe("media de asset Knowledge", () => {
  beforeEach(() => {
    h.row = {
      id: ATTACHMENT,
      file_name: "manual.pdf",
      file_size: 7,
      mime_type: "application/pdf",
      storage_path: clickUpAssetFinalPath({
        organizationId: ORG,
        workspaceId: "wk",
        targetKind: "knowledge",
        targetId: SOURCE,
        sha256: "a".repeat(64),
        extension: "pdf",
      }),
    };
    h.download.mockReset().mockResolvedValue({
      data: new Blob(["arquivo"], { type: "application/pdf" }),
      error: null,
    });
  });

  it("baixa server-side sem expor storage e com nosniff", async () => {
    const response = await GET(new Request("https://deskcomm.test"), {
      params: Promise.resolve({ id: SOURCE, attachmentId: ATTACHMENT }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("recusa path de outro source antes de tocar storage", async () => {
    h.row = { ...h.row!, storage_path: String(h.row!.storage_path).replace(SOURCE, ATTACHMENT) };
    const response = await GET(new Request("https://deskcomm.test"), {
      params: Promise.resolve({ id: SOURCE, attachmentId: ATTACHMENT }),
    });
    expect(response.status).toBe(404);
    expect(h.download).not.toHaveBeenCalled();
  });
});
