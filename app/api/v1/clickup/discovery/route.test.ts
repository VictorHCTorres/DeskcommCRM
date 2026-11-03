import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/api/idempotency", () => ({
  chaveDaRequisicao: vi.fn(() => "00000000-0000-4000-8000-000000000099"),
  comIdempotencia: vi.fn(),
  JANELA_LONGA_DA_RESERVA_MS: 15 * 60 * 1000,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/clickup/store", () => ({
  ClickUpStoreError: class ClickUpStoreError extends Error {},
  loadClickUpConnectionSecret: vi.fn(),
  stageClickUpPreview: vi.fn(),
}));
vi.mock("@/lib/clickup/crm/discovery-api", () => ({ discoverClickUpCrmApi: vi.fn() }));
vi.mock("@/lib/clickup/crypto", () => ({ decryptClickUpToken: vi.fn() }));

import { comIdempotencia } from "@/lib/api/idempotency";
import { discoverClickUpCrmApi } from "@/lib/clickup/crm/discovery-api";
import { loadClickUpConnectionSecret, stageClickUpPreview } from "@/lib/clickup/store";
import { requireRole } from "@/lib/auth/require-role";

import { POST } from "./route";

describe("discovery ClickUp idempotente", () => {
  beforeEach(() => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: "user" },
      org: { orgId: "org", role: "manager" },
    } as never);
    vi.mocked(loadClickUpConnectionSecret).mockReset();
    vi.mocked(discoverClickUpCrmApi).mockReset();
    vi.mocked(stageClickUpPreview).mockReset();
  });

  it("replay devolve o run persistido sem repetir provider nem staging", async () => {
    vi.mocked(comIdempotencia).mockResolvedValue({
      tipo: "replay",
      resposta: {
        run: { id: "00000000-0000-4000-8000-000000000088" },
        snapshot_hash: "a".repeat(64),
      },
      status: 201,
    } as never);
    const response = await POST(
      new Request("https://deskcomm.test/api/v1/clickup/discovery", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "00000000-0000-4000-8000-000000000099",
        },
        body: JSON.stringify({ connection_id: "00000000-0000-4000-8000-000000000001" }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(loadClickUpConnectionSecret).not.toHaveBeenCalled();
    expect(discoverClickUpCrmApi).not.toHaveBeenCalled();
    expect(stageClickUpPreview).not.toHaveBeenCalled();
  });
});
