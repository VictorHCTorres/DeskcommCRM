/**
 * Porta de token de servidor em /api/v1/tasks (GET/POST) e /api/v1/tasks/[id] (PATCH).
 *
 * Os robôs do n8n que criavam rotina do mês, obrigação e CND no ClickUp passam a
 * criar e mudar tarefa aqui com `Authorization: Bearer dsk_…`. O que este arquivo
 * prende:
 *  - a organização sai da autorização (linha do token), nunca do corpo;
 *  - no ramo do token não há usuário: `created_by` nulo e audit com o token;
 *  - "minhas" (`assigned_to=me`) não existe para token;
 *  - o teto de escrita do token é respeitado antes de qualquer gravação;
 *  - a recusa do auth-dual volta intacta.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({
  resolveAuthDual: vi.fn(),
  tetoDeEscritaDoToken: vi.fn(async () => null),
}));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => true,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/tarefas/atividade", () => ({
  registraAtividadeDaTarefa: vi.fn(async () => undefined),
}));
vi.mock("@/lib/tarefas/vinculos", () => ({ conferirVinculosDaTarefa: vi.fn(async () => "ok") }));
vi.mock("@/lib/tarefas/demanda", () => ({ conferirDemanda: vi.fn(async () => "ok") }));
vi.mock("@/lib/tarefas/responsavel", () => ({ conferirResponsavel: vi.fn(async () => "ok") }));
vi.mock("@/lib/tarefas/gravar-tarefa", () => ({
  COLUNAS_DA_TAREFA: "*",
  gravarTarefa: vi.fn(),
}));

import { resolveAuthDual, tetoDeEscritaDoToken } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { gravarTarefa } from "@/lib/tarefas/gravar-tarefa";

import { PATCH } from "./[id]/route";
import { GET, POST } from "./route";

const ORG_DO_TOKEN = "22222222-2222-4222-8222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";
const TAREFA_ID = "44444444-4444-4444-8444-444444444444";

const mockedAuth = vi.mocked(resolveAuthDual);
const mockedTeto = vi.mocked(tetoDeEscritaDoToken);
const mockedGravar = vi.mocked(gravarTarefa);
const mockedAudit = vi.mocked(audit);
const mockedAtividade = vi.mocked(registraAtividadeDaTarefa);

/** Cliente Supabase mínimo: toda cadeia de query termina no `resultado`. */
function clienteFalso(resultado: { data: unknown; error: unknown }) {
  const chamadas: Array<[string, unknown[]]> = [];
  const cadeia: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "is", "gte", "lte", "order", "limit", "update"]) {
    cadeia[m] = (...args: unknown[]) => {
      chamadas.push([m, args]);
      return cadeia;
    };
  }
  cadeia.maybeSingle = async () => resultado;
  cadeia.single = async () => resultado;
  cadeia.then = (ok: (v: unknown) => unknown) => Promise.resolve(resultado).then(ok);
  return { cliente: { from: () => cadeia } as never, chamadas };
}

function autorizadoPorToken(supabase: never) {
  return {
    ok: true as const,
    organizationId: ORG_DO_TOKEN,
    actor: { type: "api_token" as const, id: TOKEN_ID },
    supabase,
    via: "token" as const,
    scopes: ["mcp:read", "mcp:write"],
    apiTokenId: TOKEN_ID,
  };
}

function pedido(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    headers: { authorization: "Bearer dsk_teste", "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedTeto.mockResolvedValue(null);
});

describe("POST /api/v1/tasks por token de servidor", () => {
  it("cria na organização do token, sem created_by, e audita o token", async () => {
    const { cliente } = clienteFalso({ data: null, error: null });
    mockedAuth.mockResolvedValue(autorizadoPorToken(cliente) as never);
    mockedGravar.mockResolvedValue({
      tarefa: { id: TAREFA_ID, due_date: "2026-12-05T10:00:00.000Z", priority: "high" } as never,
      erro: null,
    });

    const res = await POST(
      pedido("https://crm.test/api/v1/tasks", {
        method: "POST",
        body: {
          title: "DCTFWeb — Cliente X — 12/2026",
          due_date: "2026-12-05T10:00:00.000Z",
          priority: "high",
          // Tentativa de escolher a organização pelo corpo: tem de ser ignorada.
          organization_id: "99999999-9999-4999-8999-999999999999",
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "agent", scope: "mcp:write", resource: "crm_tasks" }),
    );
    const linha = mockedGravar.mock.calls[0]![1] as Record<string, unknown>;
    expect(linha.organization_id).toBe(ORG_DO_TOKEN);
    expect(linha.created_by).toBeNull();
    expect(linha.title).toBe("DCTFWeb — Cliente X — 12/2026");
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_DO_TOKEN,
        actorUserId: null,
        actorApiTokenId: TOKEN_ID,
        bypassedRls: true,
        action: "crm_task.created",
      }),
    );
    expect(mockedAtividade.mock.calls[0]![1]).toEqual(
      expect.objectContaining({ actor: { type: "api_token", id: TOKEN_ID } }),
    );
  });

  it("respeita o teto de escrita do token antes de gravar", async () => {
    const { cliente } = clienteFalso({ data: null, error: null });
    mockedAuth.mockResolvedValue(autorizadoPorToken(cliente) as never);
    mockedTeto.mockResolvedValue(new Response("{}", { status: 429 }));

    const res = await POST(
      pedido("https://crm.test/api/v1/tasks", { method: "POST", body: { title: "x" } }),
    );

    expect(res.status).toBe(429);
    expect(mockedGravar).not.toHaveBeenCalled();
  });

  it("devolve intacta a recusa do auth-dual (token inválido)", async () => {
    mockedAuth.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });

    const res = await POST(
      pedido("https://crm.test/api/v1/tasks", { method: "POST", body: { title: "x" } }),
    );

    expect(res.status).toBe(401);
    expect(mockedGravar).not.toHaveBeenCalled();
  });
});

describe("GET /api/v1/tasks por token de servidor", () => {
  it("lista com escopo de leitura e filtra pela organização do token", async () => {
    const { cliente, chamadas } = clienteFalso({ data: [], error: null });
    mockedAuth.mockResolvedValue(autorizadoPorToken(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks?aberto=true"));

    expect(res.status).toBe(200);
    expect(mockedAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ role: "viewer", scope: "mcp:read" }),
    );
    expect(chamadas).toContainEqual(["eq", ["organization_id", ORG_DO_TOKEN]]);
  });

  it("recusa assigned_to=me, que só existe para quem tem sessão", async () => {
    const { cliente } = clienteFalso({ data: [], error: null });
    mockedAuth.mockResolvedValue(autorizadoPorToken(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks?assigned_to=me"));

    expect(res.status).toBe(422);
  });
});

describe("PATCH /api/v1/tasks/[id] por token de servidor", () => {
  it("muda a situação dentro da organização do token e audita o token", async () => {
    const atual = { id: TAREFA_ID, status: "pending", recurrence_id: null, lead_id: null };
    const { cliente, chamadas } = clienteFalso({ data: { ...atual, status: "done" }, error: null });
    mockedAuth.mockResolvedValue(autorizadoPorToken(cliente) as never);

    const res = await PATCH(
      pedido(`https://crm.test/api/v1/tasks/${TAREFA_ID}`, {
        method: "PATCH",
        body: { status: "done" },
      }),
      { params: Promise.resolve({ id: TAREFA_ID }) },
    );

    expect(res.status).toBe(200);
    expect(chamadas).toContainEqual(["eq", ["organization_id", ORG_DO_TOKEN]]);
    expect(mockedAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: ORG_DO_TOKEN,
        actorUserId: null,
        actorApiTokenId: TOKEN_ID,
      }),
    );
  });

  it("respeita o teto de escrita do token", async () => {
    const { cliente } = clienteFalso({ data: null, error: null });
    mockedAuth.mockResolvedValue(autorizadoPorToken(cliente) as never);
    mockedTeto.mockResolvedValue(new Response("{}", { status: 429 }));

    const res = await PATCH(
      pedido(`https://crm.test/api/v1/tasks/${TAREFA_ID}`, {
        method: "PATCH",
        body: { status: "done" },
      }),
      { params: Promise.resolve({ id: TAREFA_ID }) },
    );

    expect(res.status).toBe(429);
  });
});
