import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GrupoDeFunil } from "@/lib/pipelines/grupos";

const h = vi.hoisted(() => ({
  grupos: [] as GrupoDeFunil[],
  updates: [] as Array<Record<string, unknown>>,
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "user-1" },
    org: { orgId: "org-1", role: "manager" },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from: () => ({
      update: (patch: Record<string, unknown>) => {
        h.updates.push(patch);
        const chain = {
          eq: vi.fn(() => chain),
          then: (resolve: (value: { error: null }) => unknown) => resolve({ error: null }),
        };
        return chain;
      },
    }),
  })),
}));
vi.mock("@/lib/pipelines/grupos", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    listarGruposDeFunil: vi.fn(async () => h.grupos),
  };
});

import { PATCH } from "./route";

const item = (
  id: string,
  kind: "area" | "grupo",
  parent_id: string | null,
  position: number,
  archived_at: string | null = null,
): GrupoDeFunil => ({
  id,
  organization_id: "org-1",
  name: id,
  kind,
  parent_id,
  position,
  archived_at,
});

async function alterar(id: string, body: Record<string, unknown>) {
  return PATCH(
    new NextRequest(`http://localhost/api/v1/pipeline-groups/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );
}

describe("PATCH /api/v1/pipeline-groups/[id]", () => {
  beforeEach(() => {
    h.updates.length = 0;
    h.audit.mockClear();
    h.grupos = [
      item("00000000-0000-4000-8000-000000000001", "area", null, 1000),
      item("00000000-0000-4000-8000-000000000002", "area", null, 2000),
      item(
        "00000000-0000-4000-8000-000000000003",
        "grupo",
        "00000000-0000-4000-8000-000000000001",
        1000,
      ),
      item(
        "00000000-0000-4000-8000-000000000004",
        "grupo",
        "00000000-0000-4000-8000-000000000001",
        2000,
      ),
    ];
  });

  it("arquiva e depois restaura o mesmo Grupo", async () => {
    expect((await alterar("00000000-0000-4000-8000-000000000003", { archived: true })).status).toBe(
      200,
    );
    expect(h.updates[0]?.archived_at).toEqual(expect.any(String));

    h.grupos[2] = { ...h.grupos[2]!, archived_at: "2026-11-02T00:00:00.000Z" };
    expect(
      (await alterar("00000000-0000-4000-8000-000000000003", { archived: false })).status,
    ).toBe(200);
    expect(h.updates[1]).toMatchObject({ archived_at: null });
  });

  it("move para outra Área e reordena por vizinho sem posição crua", async () => {
    const alvo = "00000000-0000-4000-8000-000000000004";
    const novaArea = "00000000-0000-4000-8000-000000000002";
    expect((await alterar(alvo, { parent_id: novaArea })).status).toBe(200);
    expect(h.updates[0]).toMatchObject({ parent_id: novaArea, position: 1000 });

    expect((await alterar(alvo, { depois_de: null })).status).toBe(200);
    expect(h.updates[1]).toHaveProperty("position");
    expect(h.updates[1]).not.toHaveProperty("depois_de");
  });
});
