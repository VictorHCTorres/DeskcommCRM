/**
 * D9 — a chave externa única da tarefa (`crm_tasks.external_id`).
 *
 * O que este arquivo prende (contrato D9 §2 a §4):
 *  - POST: a unicidade vem do ÍNDICE (23505 com o nome dele → 409 com o id da tarefa
 *    que já tem a chave), nunca de uma leitura antes do insert; outro 23505 não vira 409;
 *    se não dá para dizer quem tem a chave, a resposta é "incerto" (503), nem 201 nem 409;
 *    o 409 não deixa auditoria nem atividade de "tarefa criada";
 *  - chave com espaço nas pontas, vazia, com controle ou com mais de 200 é 422, nunca aparada;
 *  - GET: filtro exato (parâmetro repetido, até 100) e por prefixo (com `%`, `_`, `\` escapados),
 *    sem expansão de família, e `meta.total` exato (o `count` do banco, não o tamanho do corte);
 *  - PATCH: só preenche chave ausente (`… where external_id is null`); trocar e apagar são recusados;
 *  - o cabeçalho `x-tasks-external-id: 1` em toda resposta dos três verbos.
 *
 * O banco é falso aqui; a unicidade de verdade está provada em Postgres real
 * (docs/D9-tarefas-chave-unica/PROVAS-D9.md).
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

import { resolveAuthDual } from "@/lib/api/auth-dual";
import { audit } from "@/lib/audit";
import { registraAtividadeDaTarefa } from "@/lib/tarefas/atividade";
import { LIMITE_DE_BYTES_DO_FILTRO, medidaDoFiltro } from "@/lib/tarefas/chave-externa";
import { gravarTarefa } from "@/lib/tarefas/gravar-tarefa";

import { PATCH } from "./[id]/route";
import { GET, POST } from "./route";

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";
const TAREFA_ID = "44444444-4444-4444-8444-444444444444";
const OUTRA_TAREFA_ID = "55555555-5555-4555-8555-555555555555";
const CHAVE = "dctfweb:12.345.678/0001-90:2026-12";
const INDICE = "crm_tasks_org_external_id_unique";

type Resultado = { data?: unknown; error?: unknown; count?: number | null };

/**
 * Cliente Supabase roteirizado: cada chamada TERMINAL (`maybeSingle`, `single` ou o `await`
 * da cadeia) consome o próximo resultado do roteiro. Guarda cada cadeia (tabela + chamadas).
 */
function banco(roteiro: Resultado[]) {
  const cadeias: Array<{ tabela: string; chamadas: Array<[string, unknown[]]> }> = [];
  const fila = [...roteiro];
  const proximo = (): Resultado => {
    const r = fila.shift();
    if (!r) throw new Error("o roteiro do banco falso acabou: consulta inesperada");
    return { data: null, error: null, ...r };
  };
  const cliente = {
    from: (tabela: string) => {
      const cadeia = { tabela, chamadas: [] as Array<[string, unknown[]]> };
      cadeias.push(cadeia);
      const obj: Record<string, unknown> = {};
      for (const m of [
        "select",
        "eq",
        "in",
        "filter",
        "is",
        "like",
        "ilike",
        "gte",
        "lte",
        "order",
        "limit",
        "update",
        "insert",
      ]) {
        obj[m] = (...args: unknown[]) => {
          cadeia.chamadas.push([m, args]);
          return obj;
        };
      }
      obj.maybeSingle = async () => proximo();
      obj.single = async () => proximo();
      obj.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        Promise.resolve().then(proximo).then(ok, ko);
      return obj;
    },
  };
  return { cliente: cliente as never, cadeias, sobrou: () => fila.length };
}

function autorizado(supabase: never, via: "token" | "session" = "token") {
  return {
    ok: true as const,
    organizationId: ORG,
    actor:
      via === "token"
        ? { type: "api_token" as const, id: TOKEN_ID }
        : { type: "user" as const, id: "66666666-6666-4666-8666-666666666666" },
    supabase,
    via,
    scopes: ["mcp:read", "mcp:write"],
    apiTokenId: via === "token" ? TOKEN_ID : null,
  };
}

function pedido(url: string, init?: { method?: string; body?: unknown }) {
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    headers: { authorization: "Bearer dsk_teste", "content-type": "application/json" },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const postar = (body: unknown) =>
  POST(pedido("https://crm.test/api/v1/tasks", { method: "POST", body }));
const ctx = { params: Promise.resolve({ id: TAREFA_ID }) };
const remendar = (body: unknown) =>
  PATCH(pedido(`https://crm.test/api/v1/tasks/${TAREFA_ID}`, { method: "PATCH", body }), ctx);

const mockedAuth = vi.mocked(resolveAuthDual);
const mockedGravar = vi.mocked(gravarTarefa);
const mockedAudit = vi.mocked(audit);
const mockedAtividade = vi.mocked(registraAtividadeDaTarefa);

const erroDoIndice = {
  code: "23505",
  message: `duplicate key value violates unique constraint "${INDICE}"`,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/v1/tasks — external_id", () => {
  it("grava a chave na linha e devolve 201 com o cabeçalho de capacidade", async () => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({
      tarefa: { id: TAREFA_ID, external_id: CHAVE, due_date: null, priority: "medium" } as never,
      erro: null,
    });

    const res = await postar({ title: "DCTFWeb — Cliente X — 12/2026", external_id: CHAVE });

    expect(res.status).toBe(201);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
    expect((mockedGravar.mock.calls[0]![1] as Record<string, unknown>).external_id).toBe(CHAVE);
    const corpo = await res.json();
    expect(corpo.data.task.external_id).toBe(CHAVE);
  });

  it("sem external_id, grava como antes (a chave é opcional)", async () => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({ tarefa: { id: TAREFA_ID } as never, erro: null });

    const res = await postar({ title: "avulsa" });

    expect(res.status).toBe(201);
    const linha = mockedGravar.mock.calls[0]![1] as Record<string, unknown>;
    expect(linha.external_id ?? null).toBeNull();
  });

  it("23505 no índice da chave: 409 state_conflict com o id da tarefa que já tem a chave", async () => {
    const { cliente, cadeias } = banco([{ data: { id: OUTRA_TAREFA_ID, external_id: CHAVE } }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({ tarefa: null, erro: erroDoIndice });

    const res = await postar({ title: "x", external_id: CHAVE });

    expect(res.status).toBe(409);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
    const corpo = await res.json();
    expect(corpo.error.code).toBe("state_conflict");
    expect(corpo.error.details).toEqual({ external_id: CHAVE, task_id: OUTRA_TAREFA_ID });
    // A leitura que acha o dono da chave é filtrada pela organização E pela chave.
    const leitura = cadeias[0]!;
    expect(leitura.tabela).toBe("crm_tasks");
    expect(leitura.chamadas).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(leitura.chamadas).toContainEqual(["eq", ["external_id", CHAVE]]);
  });

  it("o 409 não deixa auditoria, atividade nem nenhum efeito de tarefa criada", async () => {
    const { cliente } = banco([{ data: { id: OUTRA_TAREFA_ID } }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({ tarefa: null, erro: erroDoIndice });

    const res = await postar({ title: "x", external_id: CHAVE });

    expect(res.status).toBe(409);
    expect(mockedAudit).not.toHaveBeenCalled();
    expect(mockedAtividade).not.toHaveBeenCalled();
  });

  it("na sessão do navegador, external_id é 422 explícito: nada é gravado nem consultado", async () => {
    const { cliente, cadeias } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente, "session") as never);

    const res = await postar({ title: "x", external_id: CHAVE });

    expect(res.status).toBe(422);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
    const corpo = await res.json();
    expect(corpo.error.code).toBe("validation_failed");
    expect(corpo.error.details.external_id).toBeDefined();
    expect(mockedGravar).not.toHaveBeenCalled();
    expect(cadeias).toHaveLength(0); // sem oráculo: nenhuma leitura da chave com o cliente da sessão
  });

  it("na sessão, sem external_id, o POST segue igual", async () => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente, "session") as never);
    mockedGravar.mockResolvedValue({ tarefa: { id: TAREFA_ID } as never, erro: null });

    expect((await postar({ title: "x" })).status).toBe(201);
  });

  it("outro 23505 (de outra unicidade) NÃO vira 409 de chave: é 500", async () => {
    const { cliente, cadeias } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({
      tarefa: null,
      erro: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "crm_tasks_outra_unique"',
      },
    });

    const res = await postar({ title: "x", external_id: CHAVE });

    expect(res.status).toBe(500);
    expect(cadeias).toHaveLength(0);
  });

  it("⭐ 23505 de OUTRO índice cujo `details` traz o nome do nosso (dado da linha) é 500, não 503/409 (cxj D9v3-5)", async () => {
    const { cliente, cadeias } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({
      tarefa: null,
      erro: {
        code: "23505",
        message: 'duplicate key value violates unique constraint "cxj_outro_titulo"',
        details: `Key (title)=(${INDICE}) already exists.`,
      },
    });

    const res = await postar({ title: INDICE, external_id: CHAVE });

    expect(res.status).toBe(500);
    expect(cadeias).toHaveLength(0); // não foi procurar a "dona" de uma chave que nunca colidiu
  });

  it("23505 da chave mas a tarefa dona não é encontrada: resultado incerto (503), nem 201 nem 409", async () => {
    const { cliente } = banco([{ data: null }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({ tarefa: null, erro: erroDoIndice });

    const res = await postar({ title: "x", external_id: CHAVE });

    expect(res.status).toBe(503);
    const corpo = await res.json();
    expect(corpo.error.details).toEqual({ external_id: CHAVE, outcome: "unknown" });
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("23505 da chave mas a leitura do dono falha: resultado incerto (503)", async () => {
    const { cliente } = banco([{ data: null, error: { code: "XX000", message: "boom" } }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({ tarefa: null, erro: erroDoIndice });

    const res = await postar({ title: "x", external_id: CHAVE });

    expect(res.status).toBe(503);
  });

  it.each([
    ["espaço no início", " abc"],
    ["espaço no fim", "abc "],
    ["vazia", ""],
    ["só espaços", "   "],
    ["caractere de controle (tabulação)", "a\tb"],
    ["caractere de controle (quebra de linha)", "a\nb"],
    ["201 caracteres", "x".repeat(201)],
    ["nula", null],
    ["número", 123],
  ])("recusa com 422, sem gravar e sem aparar: %s", async (_nome, valor) => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await postar({ title: "x", external_id: valor });

    expect(res.status).toBe(422);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
    expect(mockedGravar).not.toHaveBeenCalled();
  });

  it.each([
    ["asterisco", "a*b"],
    ["NBSP no meio", "a\u00a0b"],
    ["NBSP no fim", "ab\u00a0"],
    ["NFD (ó decomposto)", "contab|rotina|6249|Pro\u0301-labore"],
    ["controle C1", "a\u0085b"],
    ["aspa dupla", 'a"b'],
    ["barra invertida", "a\\b"],
    ["vírgula e parênteses", "a,(b)"],
    ["surrogate isolado (antes: 500)", "k:\ud800"],
    ["emoji", "a😀"],
    ["o par do cxj (U+105D2 + ponto)", "k:\u{105D2}\u0307"],
  ])("D9 v3: POST recusa com 422: %s", async (_nome, valor) => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await postar({ title: "x", external_id: valor });

    expect(res.status).toBe(422);
    expect(mockedGravar).not.toHaveBeenCalled();
  });

  it("aceita 200 caracteres e recusa espaço no MEIO (sem espaço nenhum)", async () => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);
    mockedGravar.mockResolvedValue({ tarefa: { id: TAREFA_ID } as never, erro: null });

    expect((await postar({ title: "x", external_id: "x".repeat(200) })).status).toBe(201);
    expect((await postar({ title: "x", external_id: "a b" })).status).toBe(422);
    const gravadas = mockedGravar.mock.calls.map(
      (c) => (c[1] as Record<string, unknown>).external_id,
    );
    expect(gravadas).toEqual(["x".repeat(200)]);
  });

  it("a recusa da autenticação também leva o cabeçalho de capacidade", async () => {
    mockedAuth.mockResolvedValue({ ok: false, response: new Response("{}", { status: 401 }) });

    const res = await postar({ title: "x" });

    expect(res.status).toBe(401);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
  });
});

describe("GET /api/v1/tasks — filtros por chave e meta.total", () => {
  const linha = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    title: id,
    external_id: null,
    parent_task_id: null,
    ...extra,
  });

  it("external_id repetido casa exato, sem expandir a família, e traz meta.total", async () => {
    // Uma tarefa com pai: na lista da tela isso dispararia a busca do pai e das irmãs.
    const { cliente, cadeias, sobrou } = banco([
      { data: [linha(TAREFA_ID, { external_id: "a", parent_task_id: OUTRA_TAREFA_ID })], count: 1 },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks?external_id=a&external_id=b"));

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
    const corpo = await res.json();
    expect(corpo.data.tasks).toHaveLength(1);
    expect(corpo.meta.total).toBe(1);
    expect(cadeias).toHaveLength(1); // nada de pais/filhas
    expect(sobrou()).toBe(0);
    expect(cadeias[0]!.chamadas).toContainEqual(["filter", ["external_id", "in", '("a","b")']]);
    expect(cadeias[0]!.chamadas).toContainEqual(["eq", ["organization_id", ORG]]);
  });

  it("um único external_id também é filtro exato", async () => {
    const { cliente, cadeias } = banco([{ data: [], count: 0 }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks?external_id=so-uma"));

    expect(res.status).toBe(200);
    expect(cadeias[0]!.chamadas).toContainEqual(["filter", ["external_id", "in", '("so-uma")']]);
  });

  it("aceita 100 chaves e recusa 101 com 422", async () => {
    const consulta = (n: number) =>
      "https://crm.test/api/v1/tasks?" +
      Array.from({ length: n }, (_, i) => `external_id=k${i}`).join("&");
    const { cliente } = banco([{ data: [], count: 0 }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    expect((await GET(pedido(consulta(100)))).status).toBe(200);
    expect((await GET(pedido(consulta(101)))).status).toBe(422);
  });

  describe("orçamento em BYTES do filtro (D9v3-2: o transporte, não a contagem, é o limite)", () => {
    const consultaDe = (chaves: string[], prefixo?: string) =>
      "https://crm.test/api/v1/tasks?" +
      [
        ...chaves.map((c) => `external_id=${encodeURIComponent(c)}`),
        ...(prefixo ? [`external_id_prefix=${encodeURIComponent(prefixo)}`] : []),
      ].join("&");
    /** `n` chaves ASCII distintas cuja soma codificada é exatamente `total`. */
    const chavesComSoma = (n: number, total: number) => {
      const base = Math.floor(total / n);
      let resto = total - base * n;
      return Array.from({ length: n }, (_, i) => {
        const extra = resto > 0 ? 1 : 0;
        resto -= extra;
        return `${String(i).padStart(3, "0")}`.padEnd(base + extra, "x");
      });
    };

    it("⭐ o lote do cxj (10 x 193 letras acentuadas, todas válidas) é 422 CLARO, não 500", async () => {
      const { cliente, cadeias } = banco([]);
      mockedAuth.mockResolvedValue(autorizado(cliente) as never);
      const lote = Array.from({ length: 10 }, (_, i) => `cxj:limite:${i}:` + "á".repeat(180));

      const res = await GET(pedido(consultaDe(lote)));

      expect(res.status).toBe(422);
      expect(res.headers.get("x-tasks-external-id")).toBe("1");
      const corpo = await res.json();
      expect(corpo.error.code).toBe("validation_failed");
      expect(corpo.error.details.limite_get.bytes_lista).toBe(LIMITE_DE_BYTES_DO_FILTRO);
      expect(corpo.error.details.limite_get.medido).toBe(medidaDoFiltro(lote, undefined));
      expect(JSON.stringify(corpo)).toMatch(/subdivid/i);
      expect(cadeias).toHaveLength(0); // nem chegou ao banco
    });

    it("exatamente no orçamento passa (200); um byte acima é 422", async () => {
      const { cliente } = banco([{ data: [], count: 0 }]);
      mockedAuth.mockResolvedValue(autorizado(cliente) as never);
      const noLimite = chavesComSoma(40, LIMITE_DE_BYTES_DO_FILTRO);
      expect(medidaDoFiltro(noLimite, undefined)).toBe(LIMITE_DE_BYTES_DO_FILTRO);
      expect((await GET(pedido(consultaDe(noLimite)))).status).toBe(200);

      const acima = chavesComSoma(40, LIMITE_DE_BYTES_DO_FILTRO + 1);
      expect((await GET(pedido(consultaDe(acima)))).status).toBe(422);
    });

    it("o prefixo conta na mesma soma que as chaves", async () => {
      const { cliente } = banco([{ data: [], count: 0 }]);
      mockedAuth.mockResolvedValue(autorizado(cliente) as never);
      const prefixo = "p".repeat(100);
      const chaves = chavesComSoma(30, LIMITE_DE_BYTES_DO_FILTRO - 100);
      expect((await GET(pedido(consultaDe(chaves, prefixo)))).status).toBe(200);
      const res = await GET(pedido(consultaDe(chavesComSoma(30, LIMITE_DE_BYTES_DO_FILTRO - 99), prefixo)));
      expect(res.status).toBe(422);
    });

    it("a medida é do valor CODIFICADO: 100 chaves de 30 letras acentuadas estouram, as mesmas em ASCII passam", async () => {
      const { cliente } = banco([{ data: [], count: 0 }]);
      mockedAuth.mockResolvedValue(autorizado(cliente) as never);
      const acentuadas = Array.from({ length: 100 }, (_, i) => `k${i}`.padEnd(4, "x") + "á".repeat(26));
      const ascii = Array.from({ length: 100 }, (_, i) => `k${i}`.padEnd(30, "x"));
      expect((await GET(pedido(consultaDe(acentuadas)))).status).toBe(422);
      expect((await GET(pedido(consultaDe(ascii)))).status).toBe(200);
    });

    it("recusa a lista toda, nunca devolve lista vazia nem parcial no lugar do erro", async () => {
      const { cliente } = banco([{ data: [], count: 0 }]);
      mockedAuth.mockResolvedValue(autorizado(cliente) as never);
      const res = await GET(pedido(consultaDe(chavesComSoma(100, LIMITE_DE_BYTES_DO_FILTRO + 500))));
      expect(res.status).toBe(422);
      expect((await res.json()).data).toBeUndefined();
    });
  });

  it("external_id vazio é 422 (não vira 'a lista inteira')", async () => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks?external_id="));

    expect(res.status).toBe(422);
  });

  it("external_id_prefix casa por prefixo, sem expandir a família", async () => {
    const { cliente, cadeias } = banco([
      { data: [linha(TAREFA_ID, { parent_task_id: OUTRA_TAREFA_ID })], count: 1 },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(
      pedido(`https://crm.test/api/v1/tasks?external_id_prefix=${encodeURIComponent("contab|rotina|6249|")}`),
    );

    expect(res.status).toBe(200);
    expect(cadeias).toHaveLength(1);
    expect(cadeias[0]!.chamadas).toContainEqual(["like", ["external_id", "contab|rotina|6249|%"]]);
  });

  it.each(["100%_a", "a\\b", 'a"b', "a,b", "a(b)"])(
    "prefixo e chave exata fora do domínio (%j) são 422 antes de tocar o banco",
    async (valor) => {
      const { cliente } = banco([]);
      mockedAuth.mockResolvedValue(autorizado(cliente) as never);
      for (const param of ["external_id_prefix", "external_id"]) {
        const res = await GET(pedido(`https://crm.test/api/v1/tasks?${param}=${encodeURIComponent(valor)}`));
        expect(res.status).toBe(422);
      }
    },
  );

  it("external_id_prefix vazio ou repetido é 422", async () => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    expect((await GET(pedido("https://crm.test/api/v1/tasks?external_id_prefix="))).status).toBe(
      422,
    );
    expect(
      (await GET(pedido("https://crm.test/api/v1/tasks?external_id_prefix=a&external_id_prefix=b")))
        .status,
    ).toBe(422);
  });

  it.each([
    ["external_id exato com asterisco", "external_id=" + encodeURIComponent("a*b")],
    ["external_id exato com NBSP", "external_id=" + encodeURIComponent("a\u00a0b")],
    ["external_id exato em NFD", "external_id=" + encodeURIComponent("Pro\u0301")],
    ["prefixo com asterisco", "external_id_prefix=" + encodeURIComponent("star*literal")],
    ["prefixo com NBSP", "external_id_prefix=" + encodeURIComponent("a\u00a0b")],
    ["prefixo em NFD", "external_id_prefix=" + encodeURIComponent("Pro\u0301")],
  ])("422 explícito, sem consultar o banco: %s", async (_nome, consulta) => {
    const { cliente, cadeias } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(pedido(`https://crm.test/api/v1/tasks?${consulta}`));

    expect(res.status).toBe(422);
    expect(cadeias).toHaveLength(0);
  });

  it("prefixo com acento em NFC passa e chega ao banco, com a barra escapada", async () => {
    const { cliente, cadeias } = banco([{ data: [], count: 0 }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(
      pedido(
        "https://crm.test/api/v1/tasks?external_id_prefix=" +
          encodeURIComponent("contab|rotina|6249|Folha/Pró-labore|"),
      ),
    );

    expect(res.status).toBe(200);
    expect(cadeias[0]!.chamadas).toContainEqual([
      "like",
      ["external_id", "contab|rotina|6249|Folha/Pró-labore|%"],
    ]);
  });

  // D9 v2 (cxj D9-3): `meta.total` é a contagem da consulta BASE, antes da expansão de família, e
  // `meta.cortada` diz se essa consulta passou do limite. Receber == total só certifica
  // completude nas consultas por chave; na lista expandida, olhe `cortada`.
  it.each([
    [0, false],
    [500, false],
    [501, true],
    [731, true],
  ])("meta.cortada com count=%i é %s (consulta por chave)", async (count, cortada) => {
    const { cliente } = banco([{ data: [], count }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks?external_id_prefix=bulk:"));

    const corpo = await res.json();
    expect(corpo.meta).toEqual({ total: count, cortada });
  });

  it("⭐ contraprova da família (cxj): 500 filhas + count 501, a lista expandida recebe 501 == total, mas `cortada` é true", async () => {
    const filhas = Array.from({ length: 500 }, (_, i) =>
      linha(`f${i}`, { parent_task_id: OUTRA_TAREFA_ID }),
    );
    const { cliente } = banco([
      { data: filhas, count: 501 },
      { data: [linha(OUTRA_TAREFA_ID)] }, // o pai que não casa com o filtro, trazido pela expansão
      { data: filhas },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(
      pedido("https://crm.test/api/v1/tasks?status=pending&due_from=2050-01-01T00:00:00Z"),
    );

    const corpo = await res.json();
    expect(corpo.data.tasks).toHaveLength(501);
    expect(corpo.meta.total).toBe(501); // a igualdade enganosa que o cxj mediu...
    expect(corpo.meta.cortada).toBe(true); // ...e o sinal que a desfaz
  });

  it("meta.total é o count do banco, não o tamanho do corte de 500", async () => {
    const corte = Array.from({ length: 500 }, (_, i) => linha(`t${i}`));
    const { cliente, cadeias } = banco([{ data: corte, count: 731 }, { data: [] }, { data: [] }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks"));

    const corpo = await res.json();
    expect(corpo.data.tasks).toHaveLength(500);
    expect(corpo.meta.total).toBe(731);
    expect(corpo.meta.cortada).toBe(true);
    expect(cadeias[0]!.chamadas).toContainEqual([
      "select",
      [expect.any(String), { count: "exact" }],
    ]);
    expect(cadeias[0]!.chamadas).toContainEqual(["limit", [500]]);
  });

  it("sem os filtros novos a rota segue expandindo a família, como na 1.101.0", async () => {
    const filha = linha(TAREFA_ID, { parent_task_id: OUTRA_TAREFA_ID });
    const { cliente, cadeias } = banco([
      { data: [filha], count: 1 },
      { data: [linha(OUTRA_TAREFA_ID)] }, // o pai que faltava
      { data: [filha] }, // as filhas da raiz
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks"));

    const corpo = await res.json();
    expect(cadeias).toHaveLength(3);
    expect(corpo.data.tasks).toHaveLength(2);
    expect(corpo.meta.total).toBe(1);
  });

  it("sem count numérico a rota recusa (500) em vez de calar o total", async () => {
    const { cliente } = banco([{ data: [], count: null }]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await GET(pedido("https://crm.test/api/v1/tasks?external_id=a"));

    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/v1/tasks/[id] — adoção da chave", () => {
  const antes = { status: "pending", recurrence_id: null, external_id: null };

  it("na sessão do navegador, external_id é 422 explícito e nenhum update é emitido", async () => {
    const { cliente, cadeias } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente, "session") as never);

    const res = await remendar({ external_id: CHAVE });

    expect(res.status).toBe(422);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
    expect((await res.json()).error.details.external_id).toBeDefined();
    expect(cadeias).toHaveLength(0);
  });

  it("na sessão, o PATCH sem external_id segue igual", async () => {
    const { cliente } = banco([
      { data: antes },
      { data: { id: TAREFA_ID, status: "done", external_id: null } },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente, "session") as never);

    expect((await remendar({ status: "done" })).status).toBe(200);
  });

  it("preenche a chave de tarefa que não tem, num update com `external_id is null`", async () => {
    const { cliente, cadeias } = banco([
      { data: antes },
      { data: { id: TAREFA_ID, status: "pending", external_id: CHAVE } },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await remendar({ external_id: CHAVE });

    expect(res.status).toBe(200);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
    const atualiza = cadeias[1]!;
    expect(atualiza.chamadas).toContainEqual(["update", [{ external_id: CHAVE }]]);
    expect(atualiza.chamadas).toContainEqual(["is", ["external_id", null]]);
    expect(atualiza.chamadas).toContainEqual(["eq", ["organization_id", ORG]]);
  });

  it("sem external_id no corpo o update não leva a guarda da chave", async () => {
    const { cliente, cadeias } = banco([
      { data: antes },
      { data: { id: TAREFA_ID, status: "done", external_id: "ja-tinha" } },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await remendar({ status: "done" });

    expect(res.status).toBe(200);
    expect(cadeias[1]!.chamadas.some(([m]) => m === "is")).toBe(false);
  });

  it.each([
    ["apagar (null)", null],
    ["vazia", ""],
    ["espaço nas pontas", " a "],
    ["201 caracteres", "x".repeat(201)],
  ])("recusa com 422: %s", async (_nome, valor) => {
    const { cliente } = banco([]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await remendar({ external_id: valor });

    expect(res.status).toBe(422);
    expect(res.headers.get("x-tasks-external-id")).toBe("1");
  });

  it("chave que outra tarefa já tem: 409 com o id dessa outra tarefa", async () => {
    const { cliente } = banco([
      { data: antes },
      { data: null, error: erroDoIndice },
      { data: { id: OUTRA_TAREFA_ID } }, // quem tem a chave
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await remendar({ external_id: CHAVE });

    expect(res.status).toBe(409);
    const corpo = await res.json();
    expect(corpo.error.code).toBe("state_conflict");
    expect(corpo.error.details).toEqual({ external_id: CHAVE, task_id: OUTRA_TAREFA_ID });
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("tarefa que já tem OUTRA chave: 409, a chave existente não é trocada", async () => {
    const { cliente } = banco([
      { data: { ...antes, external_id: "chave-velha" } },
      { data: null, error: { code: "PGRST116", message: "0 rows" } },
      { data: { external_id: "chave-velha" } },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await remendar({ external_id: CHAVE });

    expect(res.status).toBe(409);
    const corpo = await res.json();
    expect(corpo.error.details).toEqual({
      reason: "external_id_already_set",
      external_id: "chave-velha",
    });
    expect(mockedAudit).not.toHaveBeenCalled();
  });

  it("corrida: o update não achou linha e a tarefa sumiu: 404", async () => {
    const { cliente } = banco([
      { data: null },
      { data: null, error: { code: "PGRST116", message: "0 rows" } },
      { data: null },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await remendar({ external_id: CHAVE });

    expect(res.status).toBe(404);
  });

  it("repetir a MESMA chave que a tarefa já tem é idempotente: 200, sem regravar a chave", async () => {
    const tarefa = { id: TAREFA_ID, status: "pending", external_id: CHAVE };
    const { cliente, cadeias } = banco([
      { data: { ...antes, external_id: CHAVE } },
      { data: null, error: { code: "PGRST116", message: "0 rows" } }, // a guarda não casou
      { data: tarefa }, // a leitura que diz que a chave é a mesma
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await remendar({ external_id: CHAVE });

    expect(res.status).toBe(200);
    expect((await res.json()).data.task.external_id).toBe(CHAVE);
    // Um único `update`, o guardado: a chave nunca é regravada.
    const updates = cadeias.filter((c) => c.chamadas.some(([m]) => m === "update"));
    expect(updates).toHaveLength(1);
    expect(updates[0]!.chamadas).toContainEqual(["is", ["external_id", null]]);
  });

  it("a MESMA chave junto de outros campos: a chave é ignorada e o resto é gravado sem guarda", async () => {
    const { cliente, cadeias } = banco([
      { data: antes },
      { data: null, error: { code: "PGRST116", message: "0 rows" } },
      { data: { id: TAREFA_ID, status: "pending", external_id: CHAVE } },
      { data: { id: TAREFA_ID, status: "pending", priority: "high", external_id: CHAVE } },
    ]);
    mockedAuth.mockResolvedValue(autorizado(cliente) as never);

    const res = await remendar({ external_id: CHAVE, priority: "high" });

    expect(res.status).toBe(200);
    const updates = cadeias.filter((c) => c.chamadas.some(([m]) => m === "update"));
    expect(updates[1]!.chamadas).toContainEqual(["update", [{ priority: "high" }]]);
    expect(updates[1]!.chamadas.some(([m]) => m === "is")).toBe(false);
  });
});
