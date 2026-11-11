// @vitest-environment node
/**
 * D9 — A VOLTA: o app 1.101.0 (SEM a chave externa) sobre o banco JÁ MIGRADO (coluna, índice, trigger).
 *
 * Roda no worktree da BASE (587fbbe81), com os handlers de `app/api/v1/tasks` da 1.101.0, contra o
 * PostgREST do gate. Prova que o rollback do app para 1.101.0 mantendo o schema aditivo não quebra
 * o que a 1.101.0 faz: criar, listar, editar e concluir tarefa — inclusive tarefa que já tem chave.
 */
import { execFileSync } from "node:child_process";
import { createHmac } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/api/auth-dual", () => ({ resolveAuthDual: vi.fn(), tetoDeEscritaDoToken: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => ({})) }));
vi.mock("@/lib/tarefas/atividade", () => ({ registraAtividadeDaTarefa: vi.fn(async () => undefined) }));

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { PATCH } from "@/app/api/v1/tasks/[id]/route";
import { GET, POST } from "@/app/api/v1/tasks/route";

const URL_REST = process.env.D9_POSTGREST_URL ?? "";
const SEGREDO = process.env.D9_JWT_SECRET ?? "";
const CONTAINER = process.env.D9_PG_CONTAINER ?? "";
if (!URL_REST || !SEGREDO || !CONTAINER) throw new Error("variáveis do gate ausentes");

const ORG = "d9c00000-0000-4000-8000-00000000000a";
const USER = "d9c00000-1111-4000-8000-000000000001";
const psql = (s: string) =>
  execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], { input: s, encoding: "utf8" }).trim();
const jwt = (role: string) => {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const h = enc({ alg: "HS256", typ: "JWT" });
  const b = enc({ role, sub: USER, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${h}.${b}.${createHmac("sha256", SEGREDO).update(`${h}.${b}`).digest("base64url")}`;
};
const cli = (role: string) =>
  createClient(URL_REST, jwt(role), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (u, o) => fetch(String(u).replace("/rest/v1/", "/"), o) },
  });
const servico = cli("service_role");
const sessao = cli("authenticated");

const com = (db: ReturnType<typeof cli>, via: "token" | "session") =>
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true, organizationId: ORG, actor: { type: via === "token" ? "api_token" : "user", id: via === "token" ? "d9c00000-9999-4000-8000-000000000001" : USER },
    supabase: db, via, scopes: ["mcp:read", "mcp:write"], apiTokenId: via === "token" ? "d9c00000-9999-4000-8000-000000000001" : null,
  } as never);
const json = (m: string, u: string, corpo?: unknown) =>
  new NextRequest(`http://local.test${u}`, { method: m, ...(corpo === undefined ? {} : { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }) });

beforeAll(() => {
  psql(`
    insert into auth.users (id, email) values ('${USER}', 'volta@real.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values ('${ORG}', 'd9-volta', 'D9 Volta', 'V') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values ('${USER}', '${ORG}', 'admin', now()) on conflict do nothing;
    insert into public.crm_tasks (id, organization_id, title, external_id) values
      ('d9c00000-7777-4000-8000-000000000001', '${ORG}', 'com chave', 'contab|rotina|6249|DAS|09/2026');
  `);
});

describe("1.101.0 sobre o banco migrado (coluna + índice + gatilho presentes)", () => {
  it("o catálogo está migrado (a premissa do teste)", () => {
    expect(psql(`select count(*) from pg_trigger where tgname='zz_crm_tasks_chave_externa_ultimo' and not tgisinternal`)).toBe("1");
  });

  for (const via of ["token", "session"] as const) {
    it(`[${via}] cria, lista, edita e conclui tarefa como na 1.101.0`, async () => {
      com(via === "token" ? servico : sessao, via);
      const criada = await POST(json("POST", "/api/v1/tasks", { title: `volta ${via}` }));
      expect(criada.status).toBe(201);
      const id = (await criada.json()).data.task.id as string;
      const lista = await GET(json("GET", "/api/v1/tasks"));
      expect(lista.status).toBe(200);
      const edita = await PATCH(json("PATCH", `/api/v1/tasks/${id}`, { title: "renomeada" }), { params: Promise.resolve({ id }) });
      expect(edita.status).toBe(200);
      const conclui = await PATCH(json("PATCH", `/api/v1/tasks/${id}`, { status: "done" }), { params: Promise.resolve({ id }) });
      expect(conclui.status).toBe(200);
      expect(psql(`select status from public.crm_tasks where id='${id}'`)).toBe("done");
    });

    it(`[${via}] edita e conclui a tarefa que JÁ TEM chave (o gatilho só barra mexer na chave/organização)`, async () => {
      com(via === "token" ? servico : sessao, via);
      const id = "d9c00000-7777-4000-8000-000000000001";
      const r = await PATCH(json("PATCH", `/api/v1/tasks/${id}`, { title: `com chave ${via}`, status: "done" }), { params: Promise.resolve({ id }) });
      expect(r.status).toBe(200);
      expect(psql(`select external_id from public.crm_tasks where id='${id}'`)).toBe("contab|rotina|6249|DAS|09/2026");
    });
  }

  it("a 1.101.0 não conhece `external_id`: o corpo com a chave NÃO grava chave (comportamento observado, registrado)", async () => {
    com(servico, "token");
    const r = await POST(json("POST", "/api/v1/tasks", { title: "ignora chave", external_id: "volta:x" }));
    const corpo = await r.json();
    // Observado: o que a 1.101.0 faz com um campo que ela não conhece. Se mudar, o rollback muda de natureza.
    expect([201, 422]).toContain(r.status);
    if (r.status === 201) {
      expect(psql(`select coalesce(external_id,'(nulo)') from public.crm_tasks where id='${corpo.data.task.id}'`)).toBe("(nulo)");
    }
  });
});
