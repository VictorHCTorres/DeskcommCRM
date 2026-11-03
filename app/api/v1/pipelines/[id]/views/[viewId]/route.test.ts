import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: "viewer",
  patch: null as Record<string, unknown> | null,
  deleted: false,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "00000000-0000-4000-8000-000000000001" },
    org: { orgId: "00000000-0000-4000-8000-000000000002", role: h.role },
  })),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { createClient } from "@/lib/supabase/server";

import { DELETE, PATCH } from "./route";

const view = {
  id: "00000000-0000-4000-8000-000000000004",
  organization_id: "00000000-0000-4000-8000-000000000002",
  pipeline_id: "00000000-0000-4000-8000-000000000003",
  owner_user_id: "00000000-0000-4000-8000-000000000001",
  created_by: "00000000-0000-4000-8000-000000000001",
  name: "Minha carteira",
  visibility: "personal",
  view_type: "quadro",
  filters: {},
  sort_config: { field: "position", direction: "asc" },
  view_config: {},
  schema_version: 1,
  position: 1000,
  created_at: "2026-11-02T00:00:00Z",
  updated_at: "2026-11-02T00:00:00Z",
};

const ctx = {
  params: Promise.resolve({ id: view.pipeline_id, viewId: view.id }),
};

function dbDouble(error: { code: string; message: string } | null = null) {
  const query = {
    select: vi.fn(),
    update: vi.fn((patch: Record<string, unknown>) => {
      h.patch = patch;
      return query;
    }),
    delete: vi.fn(() => {
      h.deleted = true;
      return query;
    }),
    eq: vi.fn(() => query),
    maybeSingle: vi.fn(async () => ({ data: view, error: null })),
    single: vi.fn(async () => ({ data: { ...view, ...h.patch }, error })),
    then: (resolve: (value: { error: typeof error }) => unknown) => resolve({ error }),
  };
  query.select.mockReturnValue(query);
  return { from: vi.fn(() => query) };
}

describe("PATCH/DELETE /pipelines/[id]/views/[viewId]", () => {
  beforeEach(() => {
    h.role = "viewer";
    h.patch = null;
    h.deleted = false;
    vi.mocked(createClient).mockResolvedValue(dbDouble() as never);
  });

  it("atualiza a visão pessoal do próprio usuário com payload canônico", async () => {
    const response = await PATCH(
      new NextRequest(`http://localhost/api/v1/pipelines/${view.pipeline_id}/views/${view.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "  Carteira aberta  ", filters: { status: "open" } }),
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(h.patch).toEqual(
      expect.objectContaining({
        name: "Carteira aberta",
        owner_user_id: view.owner_user_id,
        filters: { status: "open" },
      }),
    );
  });

  it("exclui a visão pessoal do próprio usuário", async () => {
    const response = await DELETE(
      new NextRequest(`http://localhost/api/v1/pipelines/${view.pipeline_id}/views/${view.id}`, {
        method: "DELETE",
      }),
      ctx,
    );

    expect(response.status).toBe(200);
    expect(h.deleted).toBe(true);
    await expect(response.json()).resolves.toMatchObject({ data: { deleted: true } });
  });

  it("não vaza SQL/schema em falhas de atualização ou exclusão", async () => {
    const segredo = 'column "owner_id" does not exist';
    vi.mocked(createClient).mockResolvedValue(
      dbDouble({ code: "42703", message: segredo }) as never,
    );
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const patch = await PATCH(
      new NextRequest(`http://localhost/api/v1/pipelines/${view.pipeline_id}/views/${view.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Outra" }),
      }),
      ctx,
    );
    const remove = await DELETE(
      new NextRequest(`http://localhost/api/v1/pipelines/${view.pipeline_id}/views/${view.id}`, {
        method: "DELETE",
      }),
      ctx,
    );
    const [patchBody, removeBody] = await Promise.all([patch.text(), remove.text()]);

    expect(patch.status).toBe(500);
    expect(remove.status).toBe(500);
    expect(patchBody).not.toContain(segredo);
    expect(removeBody).not.toContain(segredo);
    expect(patchBody).toContain("Não foi possível atualizar a visualização.");
    expect(removeBody).toContain("Não foi possível excluir a visualização.");
    expect(log).toHaveBeenCalledTimes(2);
    log.mockRestore();
  });
});
