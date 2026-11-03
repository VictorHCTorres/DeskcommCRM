import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/api/idempotency", () => ({
  chaveDaRequisicao: vi.fn(() => "00000000-0000-4000-8000-000000000099"),
  comIdempotencia: vi.fn(),
  JANELA_LONGA_DA_RESERVA_MS: 15 * 60 * 1000,
}));
vi.mock("@/lib/clickup/store", () => ({
  ClickUpStoreError: class ClickUpStoreError extends Error {},
  stageClickUpPreview: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { requireRole } from "@/lib/auth/require-role";
import { comIdempotencia } from "@/lib/api/idempotency";
import { stageClickUpPreview } from "@/lib/clickup/store";
import { createAdminClient } from "@/lib/supabase/admin";

import { POST } from "./route";

const ORG = "00000000-0000-4000-8000-000000000010";
const USER = "00000000-0000-4000-8000-000000000011";
const PATH = `${ORG}/${USER}/bundle.json`;

function manifest(scope: "docs" | "all") {
  return {
    connection_id: "00000000-0000-4000-8000-000000000001",
    workspace_id: "wk",
    source: "bundle",
    scope,
    manifest_version: 3,
    objects: [
      {
        source_type: "doc",
        source_id: "doc-private",
        metadata: { private: true },
        content_access: "full",
        payload: { format: "markdown", content: "conteúdo privado" },
      },
    ],
  };
}

describe("bundle CRM não contorna o gate administrativo de Docs", () => {
  beforeEach(() => {
    vi.mocked(stageClickUpPreview).mockReset();
    vi.mocked(comIdempotencia).mockImplementation(async (input) => {
      const result = await input.executar();
      return { tipo: "executou", ...result } as never;
    });
    vi.mocked(requireRole).mockResolvedValue({
      ok: true,
      user: { id: USER, is_platform_admin: false },
      org: { orgId: ORG, role: "manager" },
    } as never);
  });

  for (const scope of ["docs", "all"] as const) {
    it(`recusa scope ${scope} antes do staging`, async () => {
      const remove = vi.fn(async () => ({ data: [], error: null }));
      vi.mocked(createAdminClient).mockReturnValue({
        storage: {
          from: () => ({
            download: async () => ({
              data: new Blob([JSON.stringify(manifest(scope))], { type: "application/json" }),
              error: null,
            }),
            remove,
          }),
        },
      } as never);
      const response = await POST(
        new Request("https://deskcomm.test/api/v1/clickup/imports/bundle", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": "00000000-0000-4000-8000-000000000099",
          },
          body: JSON.stringify({ action: "stage", path: PATH }),
        }),
      );
      expect(response.status).toBe(422);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringContaining("somente bundles CRM") },
      });
      expect(stageClickUpPreview).not.toHaveBeenCalled();
      expect(remove).toHaveBeenCalledWith([PATH]);
    });
  }

  it("replay devolve o mesmo run sem reler objeto já removido", async () => {
    vi.mocked(comIdempotencia).mockResolvedValue({
      tipo: "replay",
      resposta: { run: { id: "00000000-0000-4000-8000-000000000088" } },
      status: 201,
    } as never);
    const from = vi.fn();
    vi.mocked(createAdminClient).mockReturnValue({ storage: { from } } as never);
    const response = await POST(
      new Request("https://deskcomm.test/api/v1/clickup/imports/bundle", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "00000000-0000-4000-8000-000000000099",
        },
        body: JSON.stringify({ action: "stage", path: PATH }),
      }),
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("Idempotency-Replayed")).toBe("true");
    expect(from).not.toHaveBeenCalled();
    expect(stageClickUpPreview).not.toHaveBeenCalled();
  });
});
