// @vitest-environment node
/**
 * D9 — A CHAVE EXTERNA DA TAREFA CONTRA POSTGREST DE VERDADE.
 *
 * O que muda em relação aos testes de unidade das rotas: aqui o cliente é o `@supabase/supabase-js`
 * REAL falando HTTP com um PostgREST REAL sobre o baseline INTEIRO (RLS, triggers, índice), e os
 * handlers `GET`/`POST`/`PATCH` de `app/api/v1/tasks` são os de produção. Só a autenticação, a
 * auditoria e a atividade são dublês (não são o objeto da prova; sem elas o handler não precisa do
 * Next servido). Não é E2E do servidor Next, nem do GoTrue: o JWT é assinado localmente com o
 * segredo que o PostgREST recebeu, e o PostgREST assume os papéis (`SET ROLE`) de verdade.
 *
 * Roda por `scripts/test-tarefas-chave-externa-postgrest.sh`, que sobe e derruba os contêineres e
 * exporta: D9_POSTGREST_URL, D9_JWT_SECRET, D9_PG_CONTAINER e, opcionalmente, D9_CHAVES_CANONICAS
 * (JSON com as chaves canônicas da F5 e do C1, para conferir que todas passam).
 */
import { execFileSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { PATCH } from "@/app/api/v1/tasks/[id]/route";
import { GET, POST } from "@/app/api/v1/tasks/route";
import { chaveExternaSchema, valorDoFiltroIn } from "@/lib/tarefas/chave-externa";

const URL_REST = process.env.D9_POSTGREST_URL ?? "";
const SEGREDO = process.env.D9_JWT_SECRET ?? "";
const CONTAINER = process.env.D9_PG_CONTAINER ?? "";
if (!URL_REST || !SEGREDO || !CONTAINER) {
  throw new Error("D9_POSTGREST_URL, D9_JWT_SECRET e D9_PG_CONTAINER são do script do gate.");
}

const ORG_A = "d9a00000-0000-4000-8000-00000000000a";
const ORG_B = "d9a00000-0000-4000-8000-00000000000b";
const ORG_OWN = "d9a00000-0000-4000-8000-0000000000c0";
const USER_DUAS = "d9a00000-1111-4000-8000-000000000001"; // manager em A e B
const USER_AGENTE = "d9a00000-1111-4000-8000-000000000002"; // agent em ORG_OWN
const USER_OUTRO = "d9a00000-1111-4000-8000-000000000003"; // agent em ORG_OWN (dono das outras tarefas)
const TOKEN_ID = "d9a00000-9999-4000-8000-000000000001";
const LEAD = "d9a00000-6666-4000-8000-000000000001";

function psql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}
const um = (consulta: string) => psql(consulta).split("\n").pop() ?? "";

function jwt(role: string, sub: string): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const cabecalho = enc({ alg: "HS256", typ: "JWT" });
  const corpo = enc({ role, sub, exp: Math.floor(Date.now() / 1000) + 3600 });
  const assinatura = createHmac("sha256", SEGREDO).update(`${cabecalho}.${corpo}`).digest("base64url");
  return `${cabecalho}.${corpo}.${assinatura}`;
}

type Fetch = typeof fetch;
function cliente(role: string, sub: string, intercepta?: Fetch): SupabaseClient {
  // O PostgREST solto serve em `/`, o supabase-js pede `/rest/v1/`: a reescrita é só de caminho.
  const base: Fetch = intercepta ?? fetch;
  return createClient(URL_REST, jwt(role, sub), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (url, opts) => base(String(url).replace("/rest/v1/", "/"), opts) },
  });
}

const servico = cliente("service_role", USER_DUAS);
const sessaoDuas = cliente("authenticated", USER_DUAS);
const sessaoAgente = cliente("authenticated", USER_AGENTE);

function comoToken(db: SupabaseClient, org = ORG_A) {
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    organizationId: org,
    actor: { type: "api_token", id: TOKEN_ID },
    supabase: db,
    via: "token",
    scopes: ["mcp:read", "mcp:write"],
    apiTokenId: TOKEN_ID,
  } as never);
}
function comoSessao(db: SupabaseClient, org: string, user: string) {
  vi.mocked(resolveAuthDual).mockResolvedValue({
    ok: true,
    organizationId: org,
    actor: { type: "user", id: user },
    supabase: db,
    via: "session",
    scopes: [],
    apiTokenId: null,
  } as never);
}

const req = (consulta = "", corpo?: unknown) =>
  new NextRequest(`http://local.test/api/v1/tasks${consulta}`, {
    method: corpo === undefined ? "GET" : "POST",
    ...(corpo === undefined
      ? {}
      : { body: JSON.stringify(corpo), headers: { "content-type": "application/json" } }),
  });
const postar = (corpo: unknown) => POST(req("", corpo));
const remendar = (id: string, corpo: unknown) =>
  PATCH(
    new NextRequest(`http://local.test/api/v1/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(corpo),
      headers: { "content-type": "application/json" },
    }),
    { params: Promise.resolve({ id }) },
  );
const lista = async (consulta: string) => {
  const res = await GET(req(consulta));
  return { res, corpo: (await res.json()) as { data: { tasks: Array<Record<string, unknown>> }; meta: { total: number; cortada: boolean } } };
};

beforeAll(() => {
  psql(`
    insert into auth.users (id, email) values
      ('${USER_DUAS}', 'd9-duas@real.test'), ('${USER_AGENTE}', 'd9-agente@real.test'),
      ('${USER_OUTRO}', 'd9-outro@real.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'd9-real-a', 'D9 Real A', 'D9 A'), ('${ORG_B}', 'd9-real-b', 'D9 Real B', 'D9 B')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name, settings)
      values ('${ORG_OWN}', 'd9-real-own', 'D9 Real Own', 'D9 Own',
              jsonb_build_object('visibility_mode', 'own', 'colegas_podem_mexer_na_agenda', false))
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_DUAS}', '${ORG_A}', 'manager', now()), ('${USER_DUAS}', '${ORG_B}', 'manager', now()),
      ('${USER_AGENTE}', '${ORG_OWN}', 'agent', now()), ('${USER_OUTRO}', '${ORG_OWN}', 'agent', now())
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('d9a00000-5555-4000-8000-000000000001', '${ORG_A}', 'D9', 'd9') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('d9a00000-5555-4000-8000-000000000002', '${ORG_A}', 'd9a00000-5555-4000-8000-000000000001', 'Novo', 'novo', 1000)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title) values
      ('${LEAD}', '${ORG_A}', 'd9a00000-5555-4000-8000-000000000001', 'd9a00000-5555-4000-8000-000000000002', 'Negócio D9')
      on conflict do nothing;
  `);
});
beforeEach(() => {
  vi.clearAllMocks();
  comoToken(servico);
});

describe("POST: 201, 409 e o que NÃO é 409", () => {
  it("⭐ 201 e depois 409 com o id certo (PostgREST real devolve o nome do índice no erro 23505)", async () => {
    const chave = `real:${randomUUID()}`;
    const primeiro = await postar({ title: "real", external_id: chave });
    expect(primeiro.status).toBe(201);
    const tarefa = (await primeiro.json()).data.task;
    expect(tarefa.external_id).toBe(chave);
    const segundo = await postar({ title: "real de novo", external_id: chave });
    expect(segundo.status).toBe(409);
    const corpo = await segundo.json();
    expect(corpo.error.code).toBe("state_conflict");
    expect(corpo.error.details).toEqual({ external_id: chave, task_id: tarefa.id });
    expect(um(`select count(*) from public.crm_tasks where organization_id='${ORG_A}' and external_id='${chave}'`)).toBe("1");
  });

  it("o erro bruto do PostgREST traz o código 23505 e o nome do índice (a premissa do reconhecimento)", async () => {
    const chave = `bruto:${randomUUID()}`;
    await servico.from("crm_tasks").insert({ organization_id: ORG_A, title: "x", external_id: chave });
    const { error } = await servico.from("crm_tasks").insert({ organization_id: ORG_A, title: "y", external_id: chave });
    expect(error?.code).toBe("23505");
    expect(`${error?.message} ${error?.details}`).toContain("crm_tasks_org_external_id_unique");
  });

  it("outro índice único violado NÃO vira 409 de chave: é 500, e nada fica gravado", async () => {
    psql(`create unique index if not exists d9_real_titulo_unico on public.crm_tasks (organization_id, title) where title = 'titulo-unico-d9'`);
    try {
      expect((await postar({ title: "titulo-unico-d9" })).status).toBe(201);
      const res = await postar({ title: "titulo-unico-d9", external_id: `outro-indice:${randomUUID()}` });
      expect(res.status).toBe(500);
      expect(um(`select count(*) from public.crm_tasks where organization_id='${ORG_A}' and title='titulo-unico-d9'`)).toBe("1");
    } finally {
      psql(`drop index if exists public.d9_real_titulo_unico`);
    }
  });

  it("dona ausente (apagada entre o conflito e a releitura): 503 incerto; repetir dá 201 e uma linha só", async () => {
    const chave = `dona:${randomUUID()}`;
    expect((await postar({ title: "dona", external_id: chave })).status).toBe(201);
    let apagouAntes = false;
    const apagaAntesDaReleitura: Fetch = async (url, opts) => {
      const alvo = String(url);
      if (!apagouAntes && (opts?.method ?? "GET") === "GET" && alvo.includes("select=id") && alvo.includes(`external_id=eq.${encodeURIComponent(chave)}`)) {
        apagouAntes = true;
        psql(`delete from public.crm_tasks where organization_id='${ORG_A}' and external_id='${chave}'`);
      }
      return fetch(url, opts);
    };
    comoToken(cliente("service_role", USER_DUAS, apagaAntesDaReleitura));
    const res = await postar({ title: "dona de novo", external_id: chave });
    expect(apagouAntes).toBe(true);
    expect(res.status).toBe(503);
    expect((await res.json()).error.details).toEqual({ external_id: chave, outcome: "unknown" });
    comoToken(servico);
    expect((await postar({ title: "dona de novo", external_id: chave })).status).toBe(201);
    expect(um(`select count(*) from public.crm_tasks where organization_id='${ORG_A}' and external_id='${chave}'`)).toBe("1");
  });
});

describe("PATCH: adoção, repetição, conflito e corrida", () => {
  it("adota, repete (idempotente), recusa chave de outra tarefa e a troca de chave", async () => {
    const chave = `adocao:${randomUUID()}`;
    const dona = (await (await postar({ title: "dona", external_id: chave })).json()).data.task;
    const solta = (await (await postar({ title: "solta" })).json()).data.task;
    const conflito = await remendar(solta.id, { external_id: chave });
    expect(conflito.status).toBe(409);
    expect((await conflito.json()).error.details).toEqual({ external_id: chave, task_id: dona.id });
    const propria = `${chave}:propria`;
    expect((await remendar(solta.id, { external_id: propria })).status).toBe(200);
    expect((await remendar(solta.id, { external_id: propria })).status).toBe(200);
    const troca = await remendar(solta.id, { external_id: `${propria}:outra` });
    expect(troca.status).toBe(409);
    expect((await troca.json()).error.details.reason).toBe("external_id_already_set");
    expect(um(`select external_id from public.crm_tasks where id='${solta.id}'`)).toBe(propria);
  });

  it("⭐ corrida: 10 PATCH simultâneos adotando chaves diferentes na MESMA tarefa: um vence, nenhum 500", async () => {
    const solta = (await (await postar({ title: "corrida" })).json()).data.task;
    const r = await Promise.all(
      Array.from({ length: 10 }, (_, i) => remendar(solta.id, { external_id: `corrida:${solta.id}:${i}` })),
    );
    const status = r.map((x) => x.status);
    expect(status.filter((s) => s === 200)).toHaveLength(1);
    expect(status.filter((s) => s === 409)).toHaveLength(9);
    expect(um(`select external_id like 'corrida:%' from public.crm_tasks where id='${solta.id}'`)).toBe("t");
  });

  it("corrida: duas tarefas disputando a MESMA chave: uma adota, a outra recebe 409 com o id da primeira", async () => {
    const chave = `disputa:${randomUUID()}`;
    const [a, b] = await Promise.all([postar({ title: "a" }), postar({ title: "b" })]);
    const ta = (await a.json()).data.task;
    const tb = (await b.json()).data.task;
    const r = await Promise.all([remendar(ta.id, { external_id: chave }), remendar(tb.id, { external_id: chave })]);
    expect(r.map((x) => x.status).sort()).toEqual([200, 409]);
    const perdedora = r.find((x) => x.status === 409)!;
    const dono = um(`select id from public.crm_tasks where organization_id='${ORG_A}' and external_id='${chave}'`);
    expect((await perdedora.json()).error.details.task_id).toBe(dono);
  });
});

describe("GET: count com embed, corte, cortada e RLS", () => {
  beforeAll(() => {
    psql(`
      insert into public.crm_tasks (organization_id, title, external_id, lead_id)
        select '${ORG_A}', 'bulk ' || g, 'bulk:' || g, '${LEAD}' from generate_series(1, 505) g;
      insert into public.crm_tasks (organization_id, title, external_id)
        select '${ORG_A}', 'exato ' || g, 'exato500:' || g from generate_series(1, 500) g;
    `);
  });

  it("505 casam: devolve 500 com embed `lead`, total=505 e cortada=true", async () => {
    const { res, corpo } = await lista("?external_id_prefix=bulk:");
    expect(res.status).toBe(200);
    expect(corpo.data.tasks).toHaveLength(500);
    expect(corpo.meta).toEqual({ total: 505, cortada: true });
    expect(corpo.data.tasks[0]!.lead).toEqual({ id: LEAD, title: "Negócio D9" });
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
  });

  it("500 casam exatamente: total=500 e cortada=false (recebidas == total certifica a consulta por chave)", async () => {
    const { corpo } = await lista("?external_id_prefix=exato500:");
    expect(corpo.data.tasks).toHaveLength(500);
    expect(corpo.meta).toEqual({ total: 500, cortada: false });
  });

  it("⭐ contraprova da família (cxj D9-3): recebidas == total na lista expandida, mas `cortada` é verdadeira", async () => {
    const pai = randomUUID();
    psql(`
      insert into public.crm_tasks (id, organization_id, title, status) values ('${pai}', '${ORG_A}', 'pai fora do filtro', 'done');
      insert into public.crm_tasks (organization_id, title, status, parent_task_id, due_date)
        select '${ORG_A}', 'filha ' || g, 'pending', '${pai}', timestamptz '2050-01-01' + (g || ' days')::interval from generate_series(1, 500) g;
      insert into public.crm_tasks (organization_id, title, status, due_date)
        values ('${ORG_A}', 'pendente 501', 'pending', timestamptz '2051-06-01');
    `);
    const { corpo } = await lista("?status=pending&due_from=2050-01-01T00:00:00Z&due_to=2052-01-01T00:00:00Z");
    expect(corpo.meta.total).toBe(501);
    expect(corpo.data.tasks).toHaveLength(501); // 500 filhas + o pai acrescentado
    expect(corpo.data.tasks.some((t) => t.title === "pendente 501")).toBe(false); // a que casa e ficou de fora
    expect(corpo.data.tasks.some((t) => t.id === pai)).toBe(true); // o que NÃO casa entrou
    expect(corpo.meta.cortada).toBe(true); // o sinal que desfaz a igualdade enganosa
  });

  it("RLS real: o agente em `own` vê só as dele, e o total conta só o visível", async () => {
    psql(`
      insert into public.crm_tasks (organization_id, title, assigned_to, created_by, external_id) values
        ('${ORG_OWN}', 'do agente 1', '${USER_AGENTE}', '${USER_AGENTE}', 'rls:1'),
        ('${ORG_OWN}', 'do agente 2', '${USER_AGENTE}', '${USER_AGENTE}', 'rls:2'),
        ('${ORG_OWN}', 'do outro 1', '${USER_OUTRO}', '${USER_OUTRO}', 'rls:3'),
        ('${ORG_OWN}', 'do outro 2', '${USER_OUTRO}', '${USER_OUTRO}', 'rls:4'),
        ('${ORG_OWN}', 'do outro 3', '${USER_OUTRO}', '${USER_OUTRO}', 'rls:5');
    `);
    comoSessao(sessaoAgente, ORG_OWN, USER_AGENTE);
    const { corpo } = await lista("?external_id_prefix=rls:");
    expect(corpo.data.tasks.map((t) => t.external_id).sort()).toEqual(["rls:1", "rls:2"]);
    expect(corpo.meta).toEqual({ total: 2, cortada: false });
    comoToken(servico, ORG_OWN);
    expect((await lista("?external_id_prefix=rls:")).corpo.meta.total).toBe(5); // o token vê a organização
  });

  it("a organização de fora da associação do agente: lista vazia, total 0", async () => {
    comoSessao(sessaoAgente, ORG_A, USER_AGENTE);
    const { corpo } = await lista("?external_id_prefix=bulk:");
    expect(corpo.data.tasks).toHaveLength(0);
    expect(corpo.meta.total).toBe(0);
  });
});

describe("o domínio da chave pelo Supabase JS + PostgREST + LIKE de verdade (D9 v3)", () => {
  const literais = ["pref.100:a-b|1", "pref.100:a-b|2", "ponto.x", "dois:pontos", "barra/x", "Pró-labore|ação"];
  beforeAll(async () => {
    for (const chave of literais) {
      const { error } = await servico.from("crm_tasks").insert({ organization_id: ORG_A, title: "lit", external_id: chave });
      expect(error, `inserir ${JSON.stringify(chave)}`).toBeNull();
    }
  });

  it.each(literais)("o filtro exato acha %j (e só ele)", async (chave) => {
    const { corpo } = await lista(`?external_id=${encodeURIComponent(chave)}`);
    expect(corpo.data.tasks.map((t) => t.external_id)).toEqual([chave]);
    expect(corpo.meta.total).toBe(1);
  });

  it("prefixo casa só o que começa com ele; vários exatos de uma vez; AND com o prefixo", async () => {
    const { corpo: p } = await lista(`?external_id_prefix=${encodeURIComponent("pref.100:a-b|")}`);
    expect(p.data.tasks.map((t) => t.external_id).sort()).toEqual(["pref.100:a-b|1", "pref.100:a-b|2"]);
    const { corpo } = await lista(`?external_id=${encodeURIComponent(literais[0]!)}&external_id=${encodeURIComponent(literais[2]!)}`);
    expect(corpo.data.tasks).toHaveLength(2);
    const e = await lista(`?external_id=${encodeURIComponent(literais[0]!)}&external_id_prefix=ponto`);
    expect(e.corpo.data.tasks).toHaveLength(0);
  });

  it("⭐ A PREMISSA DO ACHADO D9-2: o PostgREST traduz `*` em curinga do LIKE — por isso a chave não pode ter `*`", async () => {
    const { data } = await servico
      .from("crm_tasks")
      .select("external_id")
      .eq("organization_id", ORG_A)
      .like("external_id", "dois*pontos");
    expect((data ?? []).map((r) => r.external_id)).toEqual(["dois:pontos"]); // casou sem ter `*`: é curinga
  });

  // Tudo o que está FORA da lista: 422 na rota (POST, GET exato, GET por prefixo) E 23514 no banco.
  const fora: Array<[string, string]> = [
    ["asterisco", "star*literal:1"],
    ["porcento", "a%b"],
    ["sublinhado", "a_b"],
    ["barra invertida", "a\\b"],
    ["aspa dupla", 'a"b'],
    ["vírgula", "a,b"],
    ["parênteses", "a(b)"],
    ["cerquilha", "a#b"],
    ["espaço no meio", "a b"],
    ["NBSP no meio", "a\u00a0b"],
    ["NBSP no fim", "ab\u00a0"],
    ["EM SPACE", "a\u2003b"],
    ["LINE SEPARATOR", "a\u2028b"],
    ["BOM", "a\ufeffb"],
    ["controle C1", "a\u0085b"],
    ["ZWJ", "a\u200db"],
    ["NFD (ó decomposto)", "contab|rotina|6249|Pro\u0301-labore|09/2026"],
    ["o caso do cxj, decomposto (U+105D2 + ponto)", "k:\u{105D2}\u0307"],
    ["o caso do cxj, composto (U+105C9)", "k:\u{105C9}"],
    ["emoji", "a\u{1F600}"],
  ];
  it.each(fora)("fora do domínio: %s é 422 na rota (POST, GET exato, GET prefixo) E 23514 no banco", async (_nome, chave) => {
    expect((await postar({ title: "x", external_id: chave })).status).toBe(422);
    expect((await GET(req(`?external_id=${encodeURIComponent(chave)}`))).status).toBe(422);
    expect((await GET(req(`?external_id_prefix=${encodeURIComponent(chave)}`))).status).toBe(422);
    const { error } = await servico.from("crm_tasks").insert({ organization_id: ORG_A, title: "x", external_id: chave });
    expect(error?.code).toBe("23514");
    expect(error?.message).toContain("crm_tasks_external_id_formato");
  });

  it("surrogate isolado: 422 (antes: o schema deixava passar e o POST dava 500 pelo PGRST102)", async () => {
    expect((await postar({ title: "x", external_id: "k:\ud800" })).status).toBe(422);
  });

  it("⭐ nenhum caminho cria duas linhas para o mesmo texto: o decomposto e o composto do cxj não gravam", async () => {
    const antes = um(`select count(*) from public.crm_tasks where external_id like 'k:%' and organization_id='${ORG_A}'`);
    for (const chave of ["k:\u{105D2}\u0307", "k:\u{105C9}"]) {
      await servico.from("crm_tasks").insert({ organization_id: ORG_A, title: "x", external_id: chave });
      await postar({ title: "x", external_id: chave });
    }
    expect(um(`select count(*) from public.crm_tasks where external_id like 'k:%' and organization_id='${ORG_A}'`)).toBe(antes);
  });

  it("a chave canônica com acento pré-composto faz o caminho inteiro: POST, GET exato e GET por prefixo", async () => {
    const chave = `contab|rotina|6249|Folha/Pró-labore|09/2026.${randomUUID().slice(0, 8)}`;
    const res = await postar({ title: "acentuada", external_id: chave });
    expect(res.status).toBe(201);
    const exato = await lista(`?external_id=${encodeURIComponent(chave)}`);
    expect(exato.corpo.data.tasks).toHaveLength(1);
    const prefixo = await lista(`?external_id_prefix=${encodeURIComponent("contab|rotina|6249|Folha/Pró-labore|09/2026.")}`);
    expect(prefixo.corpo.data.tasks.map((t) => t.external_id)).toContain(chave);
  });

  it("o NFC e o NFD da mesma palavra nunca viram duas chaves: o NFD é recusado, só existe uma", async () => {
    const base = `nfc:${randomUUID().slice(0, 8)}:Pró`;
    expect((await postar({ title: "nfc", external_id: base.normalize("NFC") })).status).toBe(201);
    expect((await postar({ title: "nfd", external_id: base.normalize("NFD") })).status).toBe(422);
    expect((await postar({ title: "nfc de novo", external_id: base.normalize("NFC") })).status).toBe(409);
  });
});

// D9v2-1 (cxj): o `.in()` do supabase-js põe aspas em valor com `,()` mas NÃO escapa `"` e `\`; o PostgREST lê
// outra expressão. O domínio novo manda `"` e `\` para 422, mas a serialização correta fica como defesa e é
// provada AQUI, contra uma tabela SEM a constraint (a única maneira de ter chaves assim no banco).
describe("D9v2-1: o filtro `in` na gramática do PostgREST (tabela sem constraint, só para a prova)", () => {
  const casos = [
    'cxj:url:a",b',
    'cxj:url:a\\",b',
    'cxj:url:a"(b)',
    "cxj:url:a\\(b)",
    "cxj:url:a,b\\c",
  ];
  const semelhantes = ['cxj:url:a"', "cxj:url:a,b", "cxj:url:a\\", 'cxj:url:a"(b']; // contraprova: chaves parecidas
  async function esperaTabela() {
    for (let i = 0; i < 30; i++) {
      const { error } = await servico.from("d9_filtro_in").select("external_id").limit(1);
      if (!error) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error("o PostgREST não enxergou a tabela d9_filtro_in");
  }
  beforeAll(async () => {
    psql(`
      create table if not exists public.d9_filtro_in (external_id text);
      grant all on public.d9_filtro_in to service_role;
      truncate public.d9_filtro_in;
      notify pgrst, 'reload schema';
    `);
    await esperaTabela();
    const linhas = [...casos, ...semelhantes].map((external_id) => ({ external_id }));
    const { error } = await servico.from("d9_filtro_in").insert(linhas);
    expect(error).toBeNull();
  });

  it.each(casos)("serialização correta: o `in` acha EXATAMENTE a chave %j (e não as parecidas)", async (chave) => {
    const { data, error } = await servico.from("d9_filtro_in").select("external_id").filter("external_id", "in", valorDoFiltroIn([chave]));
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.external_id)).toEqual([chave]);
  });

  it("serialização correta: as cinco chaves juntas voltam as cinco, e uma ausente não traz nenhuma", async () => {
    const { data } = await servico.from("d9_filtro_in").select("external_id").filter("external_id", "in", valorDoFiltroIn(casos));
    expect((data ?? []).map((r) => r.external_id).sort()).toEqual([...casos].sort());
    const vazio = await servico.from("d9_filtro_in").select("external_id").filter("external_id", "in", valorDoFiltroIn(["cxj:nao-existe"]));
    expect(vazio.data).toEqual([]);
  });

  it("⭐ a PREMISSA do achado: o `.in()` do supabase-js erra em ao menos uma dessas chaves (ausência falsa ou chave alheia)", async () => {
    let erros = 0;
    for (const chave of casos) {
      const { data } = await servico.from("d9_filtro_in").select("external_id").in("external_id", [chave]);
      const achou = (data ?? []).map((r) => r.external_id);
      if (achou.length !== 1 || achou[0] !== chave) erros++;
    }
    expect(erros).toBeGreaterThan(0);
  });
});

// Item 4 do v3: o 23505 que NÃO cita o índice da chave nunca vira 409.
describe("23505 sem o nome do índice: nunca é 409", () => {
  it("o PostgREST devolve o 23505 mas sem o nome do índice na mensagem: a rota responde 500, não 409", async () => {
    const chave = `semnome:${randomUUID()}`;
    expect((await postar({ title: "dona", external_id: chave })).status).toBe(201);
    const semONome: Fetch = async (url, opts) => {
      const res = await fetch(url, opts);
      if ((opts?.method ?? "GET") !== "POST" || res.status !== 409) return res;
      const corpo = (await res.json()) as { message?: string; details?: string };
      const limpa = (t?: string) => (t ?? "").replaceAll("crm_tasks_org_external_id_unique", "um_indice_qualquer");
      return new Response(JSON.stringify({ ...corpo, message: limpa(corpo.message), details: limpa(corpo.details) }), {
        status: res.status,
        headers: res.headers,
      });
    };
    comoToken(cliente("service_role", USER_DUAS, semONome));
    const res = await postar({ title: "dona de novo", external_id: chave });
    expect(res.status).toBe(500);
    comoToken(servico);
    expect((await postar({ title: "dona de novo", external_id: chave })).status).toBe(409); // sem o filtro, o 409 volta
  });
});

describe("D9-1 pelo PostgREST: o JWT de quem está nas duas organizações não move nem sequestra a chave", () => {
  it("⭐ mover a tarefa com chave de A para B é recusado (42501), a chave segue ocupando A, e recriar em A dá 409", async () => {
    const chave = `mover:${randomUUID()}`;
    const t = (await (await postar({ title: "robo", external_id: chave })).json()).data.task;
    const { error, data } = await sessaoDuas.from("crm_tasks").update({ organization_id: ORG_B }).eq("id", t.id).select("id");
    expect(error?.code).toBe("42501");
    expect(error?.message).toContain("tarefa_chave_externa_imutavel");
    expect(data ?? []).toHaveLength(0);
    expect(um(`select organization_id from public.crm_tasks where id='${t.id}'`)).toBe(ORG_A);
    expect((await postar({ title: "robo recriado", external_id: chave })).status).toBe(409);
    const junto = await sessaoDuas.from("crm_tasks").update({ organization_id: ORG_B, external_id: chave }).eq("id", t.id);
    expect(junto.error?.message).toContain("tarefa_chave_externa_imutavel");
  });

  it("a sessão não troca, não limpa, não adota e não grava chave; edição normal passa", async () => {
    const chave = `sessao:${randomUUID()}`;
    const t = (await (await postar({ title: "robo", external_id: chave })).json()).data.task;
    for (const patch of [{ external_id: "outra" }, { external_id: null }]) {
      const { error } = await sessaoDuas.from("crm_tasks").update(patch).eq("id", t.id);
      expect(error?.message).toContain("tarefa_chave_externa_imutavel");
    }
    const solta = (await (await postar({ title: "solta" })).json()).data.task;
    const adota = await sessaoDuas.from("crm_tasks").update({ external_id: "sequestrada" }).eq("id", solta.id);
    expect(adota.error?.message).toContain("tarefa_chave_externa_e_do_servidor");
    const ins = await sessaoDuas.from("crm_tasks").insert({ organization_id: ORG_A, title: "x", external_id: "k-sessao" });
    expect(ins.error?.message).toContain("tarefa_chave_externa_e_do_servidor");
    const normal = await sessaoDuas.from("crm_tasks").update({ title: "renomeada", status: "done" }).eq("id", t.id).select("title");
    expect(normal.error).toBeNull();
    expect(normal.data).toEqual([{ title: "renomeada" }]);
    expect(um(`select external_id from public.crm_tasks where id='${t.id}'`)).toBe(chave);
  });

  it("mover tarefa SEM chave segue permitido (a trava só protege a identidade posta)", async () => {
    const solta = (await (await postar({ title: "movel" })).json()).data.task;
    const { error } = await sessaoDuas.from("crm_tasks").update({ organization_id: ORG_B }).eq("id", solta.id);
    expect(error).toBeNull();
  });
});

describe("as chaves canônicas da F5 e do C1 passam na regra (zod e banco) e fazem o caminho inteiro", () => {
  const f5 = [
    "contab|rotina|6249|DAS|09/2026",
    "contab|rotina|6249|Carnê-leão|09/2026",
    "contab|rotina|6249|Folha/Pró-labore|09/2026",
    "contab|cnd|6249|Federal",
    "contab|cnd|5979|Estadual",
    "contab|anual|6249|DEFIS/DASN|2026",
    "contab|anual|5979|IRPF|2026",
    "contab|onboarding|5979",
    "contab|ref|6249|Tributação",
  ];
  const doC1: string[] = process.env.D9_CHAVES_CANONICAS
    ? (JSON.parse(readFileSync(process.env.D9_CHAVES_CANONICAS, "utf8")) as string[])
    : [];

  it(`todas passam no zod e gravam pela rota (F5: ${f5.length}; C1 v6: ${doC1.length})`, async () => {
    const todas = [...new Set([...f5, ...doC1])];
    const sufixo = randomUUID().slice(0, 6);
    for (const chave of todas) {
      expect(chaveExternaSchema.safeParse(chave).success, chave).toBe(true);
      const res = await postar({ title: "canônica", external_id: `${chave}.${sufixo}` });
      expect(res.status, chave).toBe(201);
    }
    const { corpo } = await lista(`?external_id_prefix=${encodeURIComponent("contab|")}`);
    expect(corpo.meta.total).toBeGreaterThanOrEqual(todas.length);
  });
});
