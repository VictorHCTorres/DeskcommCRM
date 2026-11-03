import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ role: "viewer" }));

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

import { GET, POST } from "./route";

const ctx = {
  params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000003" }),
};

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

function queryDouble(options: {
  maybe?: unknown;
  list?: unknown[];
  single?: unknown;
  error?: { code: string; message: string };
  onInsert?: (row: Record<string, unknown>) => void;
}) {
  const query = {
    select: vi.fn(),
    eq: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    insert: vi.fn((row: Record<string, unknown>) => {
      options.onInsert?.(row);
      return query;
    }),
    maybeSingle: vi.fn(async () => ({ data: options.maybe ?? null, error: options.error ?? null })),
    single: vi.fn(async () => ({ data: options.single ?? null, error: options.error ?? null })),
    then: (
      resolve: (value: {
        data: unknown[];
        error: { code: string; message: string } | null;
      }) => unknown,
    ) => resolve({ data: options.list ?? [], error: options.error ?? null }),
  };
  query.select.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  query.order.mockReturnValue(query);
  query.limit.mockReturnValue(query);
  return query;
}

describe("POST /pipelines/[id]/views", () => {
  beforeEach(() => {
    h.role = "viewer";
    vi.clearAllMocks();
  });

  it("lista apenas as visualizações retornadas pelo escopo tenant-safe", async () => {
    const pipeline = queryDouble({ maybe: { id: view.pipeline_id } });
    const views = queryDouble({ list: [view] });
    vi.mocked(createClient).mockResolvedValue({
      from: vi.fn((table: string) => (table === "crm_pipelines" ? pipeline : views)),
    } as never);

    const response = await GET(new NextRequest("http://localhost/views"), ctx);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: [view] });
    expect(views.eq).toHaveBeenCalledWith("organization_id", view.organization_id);
    expect(views.eq).toHaveBeenCalledWith("pipeline_id", view.pipeline_id);
  });

  it("cria visualização pessoal canônica com dono e posição seguinte", async () => {
    let inserted: Record<string, unknown> | null = null;
    const pipeline = queryDouble({ maybe: { id: view.pipeline_id } });
    const position = queryDouble({ maybe: { position: 1000 } });
    const insertion = queryDouble({
      single: { ...view, position: 2000 },
      onInsert: (row) => {
        inserted = row;
      },
    });
    let viewCall = 0;
    vi.mocked(createClient).mockResolvedValue({
      from: vi.fn((table: string) => {
        if (table === "crm_pipelines") return pipeline;
        viewCall += 1;
        return viewCall === 1 ? position : insertion;
      }),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/views", {
        method: "POST",
        body: JSON.stringify({
          name: "  Minha carteira  ",
          visibility: "personal",
          view_type: "quadro",
          filters: {},
        }),
      }),
      ctx,
    );

    expect(response.status).toBe(201);
    expect(inserted).toEqual(
      expect.objectContaining({
        name: "Minha carteira",
        owner_user_id: view.owner_user_id,
        organization_id: view.organization_id,
        pipeline_id: view.pipeline_id,
        position: 2000,
      }),
    );
  });

  it("não devolve detalhes do Postgres ao falhar na listagem", async () => {
    const segredo = 'relation "crm_pipeline_views" does not exist';
    const pipeline = queryDouble({ maybe: { id: view.pipeline_id } });
    const views = queryDouble({ error: { code: "42P01", message: segredo } });
    vi.mocked(createClient).mockResolvedValue({
      from: vi.fn((table: string) => (table === "crm_pipelines" ? pipeline : views)),
    } as never);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const response = await GET(new NextRequest("http://localhost/views"), ctx);
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(segredo);
    expect(body).toContain("Não foi possível carregar as visualizações.");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("conflito de nome usa mensagem pública e não a constraint do banco", async () => {
    const segredo =
      "duplicate key value violates unique constraint crm_pipeline_views_shared_name_uidx";
    const pipeline = queryDouble({ maybe: { id: view.pipeline_id } });
    const position = queryDouble({ maybe: null });
    const insertion = queryDouble({ error: { code: "23505", message: segredo } });
    let viewCall = 0;
    vi.mocked(createClient).mockResolvedValue({
      from: vi.fn((table: string) => {
        if (table === "crm_pipelines") return pipeline;
        viewCall += 1;
        return viewCall === 1 ? position : insertion;
      }),
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/views", {
        method: "POST",
        body: JSON.stringify({ name: "Minha carteira", view_type: "quadro", filters: {} }),
      }),
      ctx,
    );
    const body = await response.text();

    expect(response.status).toBe(409);
    expect(body).not.toContain(segredo);
    expect(body).toContain("Já existe uma visualização com esse nome.");
  });

  it("recusa salvar Lista com filtro que a Lista não aplica", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/v1/pipelines/x/views", {
        method: "POST",
        body: JSON.stringify({
          name: "Busca",
          visibility: "personal",
          view_type: "lista",
          filters: { search: "Acme" },
        }),
      }),
      ctx,
    );
    expect(response.status).toBe(422);
  });

  it("viewer não cria visualização compartilhada", async () => {
    const response = await POST(
      new NextRequest("http://localhost/api/v1/pipelines/x/views", {
        method: "POST",
        body: JSON.stringify({
          name: "Equipe",
          visibility: "shared",
          view_type: "quadro",
          filters: {},
        }),
      }),
      ctx,
    );
    expect(response.status).toBe(403);
  });
});
