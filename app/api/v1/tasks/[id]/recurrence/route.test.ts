import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  argumentos,
  bancoFalso,
  operacao,
  type BancoFalso,
  type Cadeia,
  type Resposta,
} from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ banco: undefined as unknown as BancoFalso }));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    org: { orgId: "org-1" },
    user: { id: "user-1", idioma: "pt-BR" },
  }),
}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => h.banco.cliente }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

import { DELETE, PUT } from "./route";

function responder(cadeia: Cadeia): Resposta {
  if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "select") {
    return {
      data: {
        id: "task-1",
        parent_task_id: null,
        recurrence_id: null,
        recurrence_generation: 0,
        recurrence_scheduled_for: null,
        due_date: "2026-11-03T12:00:00.000Z",
      },
    };
  }
  if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "insert") {
    return { data: { id: "serie-1" } };
  }
  // Simula outro PUT vencendo o `recurrence_id is null` antes deste.
  if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "update") return { data: [] };
  return { data: null };
}

function requisicao(): NextRequest {
  return new NextRequest("http://localhost/api/v1/tasks/task-1/recurrence", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      frequency: "daily",
      interval: 1,
      mode: "on_schedule",
      timezone: "UTC",
    }),
  });
}

beforeEach(() => {
  h.banco = bancoFalso(responder);
});

describe("PUT /tasks/[id]/recurrence", () => {
  it("perde a corrida por CAS, desativa a série órfã e nunca a apaga", async () => {
    const resposta = await PUT(requisicao(), { params: Promise.resolve({ id: "task-1" }) });

    expect(resposta.status).toBe(409);
    const compensacao = h.banco.cadeias.find(
      (cadeia) =>
        cadeia.tabela === "crm_task_recurrences" &&
        operacao(cadeia) === "update" &&
        (argumentos(cadeia, "update")?.[0] as { active?: boolean })?.active === false,
    );
    expect(compensacao).toBeDefined();
    expect(h.banco.cadeias.some((cadeia) => operacao(cadeia) === "delete")).toBe(false);
  });

  it("cria inativa, vincula a tarefa por CAS e só então ativa a série", async () => {
    h.banco = bancoFalso((cadeia) => {
      if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "select") {
        return {
          data: {
            id: "task-1",
            parent_task_id: null,
            recurrence_id: null,
            recurrence_generation: 0,
            recurrence_scheduled_for: null,
            due_date: "2026-11-03T12:00:00.000Z",
          },
        };
      }
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "insert") {
        return { data: { id: "serie-1" } };
      }
      if (operacao(cadeia) === "update") return { data: [{ id: cadeia.tabela }] };
      return { data: null };
    });

    const resposta = await PUT(requisicao(), { params: Promise.resolve({ id: "task-1" }) });

    expect(resposta.status).toBe(200);
    const escritas = h.banco.cadeias.filter((cadeia) =>
      ["insert", "update"].includes(operacao(cadeia)),
    );
    expect(escritas.map((cadeia) => `${cadeia.tabela}:${operacao(cadeia)}`)).toEqual([
      "crm_task_recurrences:insert",
      "crm_tasks:update",
      "crm_task_recurrences:update",
    ]);
    const [insercaoDaSerie, vinculoDaTarefa, ativacaoDaSerie] = escritas;
    if (!insercaoDaSerie || !vinculoDaTarefa || !ativacaoDaSerie) {
      throw new Error("As três escritas da criação da recorrência eram esperadas.");
    }
    expect(argumentos(insercaoDaSerie, "insert")?.[0]).toEqual({
      organization_id: "org-1",
      frequency: "daily",
      interval: 1,
      mode: "on_schedule",
      timezone: "America/Sao_Paulo",
      current_task_id: null,
      next_run_at: null,
      next_due_at: null,
      generation: 0,
      active: false,
      created_by: "user-1",
    });
    expect(argumentos(vinculoDaTarefa, "update")?.[0]).toEqual({
      recurrence_id: "serie-1",
      recurrence_generation: 0,
      recurrence_scheduled_for: "2026-11-03T12:00:00.000Z",
    });
    expect(argumentos(ativacaoDaSerie, "update")?.[0]).toEqual({
      current_task_id: "task-1",
      generation: 0,
      next_run_at: "2026-11-04T12:00:00.000Z",
      next_due_at: null,
      active: true,
    });
    expect(ativacaoDaSerie.passos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metodo: "eq", args: ["id", "serie-1"] }),
        expect.objectContaining({ metodo: "eq", args: ["created_by", "user-1"] }),
        expect.objectContaining({ metodo: "is", args: ["current_task_id", null] }),
        expect.objectContaining({ metodo: "eq", args: ["active", false] }),
      ]),
    );
  });

  it("recusa editar a série por uma ocorrência histórica", async () => {
    h.banco = bancoFalso((cadeia) => {
      if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "select") {
        if (cadeia.passos.some((passo) => passo.metodo === "maybeSingle")) {
          return {
            data: {
              id: "task-1",
              parent_task_id: null,
              recurrence_id: "serie-1",
              recurrence_generation: 2,
              recurrence_scheduled_for: "2026-11-03T12:00:00.000Z",
              due_date: "2026-11-03T12:00:00.000Z",
            },
          };
        }
        return { data: null };
      }
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "select") {
        return {
          data: {
            updated_at: "2026-11-02T20:00:00.000Z",
            current_task_id: "task-3",
            generation: 3,
          },
        };
      }
      return { data: null };
    });

    const resposta = await PUT(requisicao(), { params: Promise.resolve({ id: "task-1" }) });

    expect(resposta.status).toBe(409);
    expect(h.banco.cadeias.some((cadeia) => operacao(cadeia) === "update")).toBe(false);
  });

  it("retoma a série própria que ficou inativa entre o vínculo e a ativação", async () => {
    h.banco = bancoFalso((cadeia) => {
      if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "select") {
        const colunas = argumentos(cadeia, "select")?.[0];
        if (typeof colunas === "string" && colunas.includes("parent_task_id")) {
          return {
            data: {
              id: "task-1",
              parent_task_id: null,
              recurrence_id: "serie-1",
              recurrence_generation: 0,
              recurrence_scheduled_for: "2026-11-03T12:00:00.000Z",
              due_date: null,
            },
          };
        }
        return {
          data: {
            recurrence_scheduled_for: "2026-11-03T12:00:00.000Z",
            due_date: null,
          },
        };
      }
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "select") {
        return {
          data: {
            updated_at: "2026-11-02T20:00:00.000Z",
            current_task_id: null,
            generation: 0,
            active: false,
            created_by: "user-1",
          },
        };
      }
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "update") {
        return { data: [{ id: "serie-1" }] };
      }
      return { data: null };
    });

    const resposta = await PUT(requisicao(), { params: Promise.resolve({ id: "task-1" }) });

    expect(resposta.status).toBe(200);
    const retomada = h.banco.cadeias.find(
      (cadeia) => cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "update",
    );
    expect(argumentos(retomada!, "update")?.[0]).toMatchObject({
      current_task_id: "task-1",
      generation: 0,
      active: true,
    });
    expect(retomada?.passos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metodo: "eq", args: ["created_by", "user-1"] }),
        expect.objectContaining({ metodo: "is", args: ["current_task_id", null] }),
        expect.objectContaining({ metodo: "eq", args: ["active", false] }),
        expect.objectContaining({ metodo: "eq", args: ["generation", 0] }),
      ]),
    );
    expect(h.banco.cadeias.some((cadeia) => operacao(cadeia) === "insert")).toBe(false);
  });

  it("usa uma âncora não nula ao criar after_completion sem prazo", async () => {
    h.banco = bancoFalso((cadeia) => {
      if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "select") {
        return {
          data: {
            id: "task-1",
            parent_task_id: null,
            recurrence_id: null,
            recurrence_generation: 0,
            recurrence_scheduled_for: null,
            due_date: null,
          },
        };
      }
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "insert") {
        return { data: { id: "serie-1" } };
      }
      if (operacao(cadeia) === "update") return { data: [{ id: cadeia.tabela }] };
      return { data: null };
    });
    const req = new NextRequest("http://localhost/api/v1/tasks/task-1/recurrence", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        frequency: "monthly",
        interval: 1,
        mode: "after_completion",
        timezone: "America/Fortaleza",
      }),
    });

    const resposta = await PUT(req, { params: Promise.resolve({ id: "task-1" }) });

    expect(resposta.status).toBe(200);
    const vinculo = h.banco.cadeias.find(
      (cadeia) => cadeia.tabela === "crm_tasks" && operacao(cadeia) === "update",
    );
    const payload = argumentos(vinculo!, "update")?.[0] as {
      recurrence_scheduled_for?: string | null;
    };
    expect(payload.recurrence_scheduled_for).toEqual(expect.any(String));
    expect(Number.isNaN(Date.parse(payload.recurrence_scheduled_for!))).toBe(false);
  });

  it("ignora o timezone do cliente e congela o fuso da organização", async () => {
    h.banco = bancoFalso((cadeia) => {
      if (cadeia.tabela === "organizations") return { data: { timezone: "America/Fortaleza" } };
      if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "select") {
        return {
          data: {
            id: "task-1",
            parent_task_id: null,
            recurrence_id: null,
            recurrence_generation: 0,
            recurrence_scheduled_for: null,
            due_date: "2026-11-03T12:00:00.000Z",
          },
        };
      }
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "insert") {
        return { data: { id: "serie-1" } };
      }
      if (operacao(cadeia) === "update") return { data: [{ id: cadeia.tabela }] };
      return { data: null };
    });

    const resposta = await PUT(requisicao(), { params: Promise.resolve({ id: "task-1" }) });

    expect(resposta.status).toBe(200);
    const insercao = h.banco.cadeias.find(
      (cadeia) => cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "insert",
    );
    expect(argumentos(insercao!, "insert")?.[0]).toMatchObject({ timezone: "America/Fortaleza" });
  });
});

describe("DELETE /tasks/[id]/recurrence", () => {
  it("usa CAS e devolve conflito quando nenhuma série foi cancelada", async () => {
    h.banco = bancoFalso((cadeia) => {
      if (cadeia.tabela === "crm_tasks") return { data: { recurrence_id: "serie-1" } };
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "select") {
        return {
          data: {
            id: "serie-1",
            active: true,
            current_task_id: "task-1",
            updated_at: "2026-11-02T20:00:00.000Z",
          },
        };
      }
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "update") {
        return { data: [] };
      }
      return { data: null };
    });

    const resposta = await DELETE(
      new NextRequest("http://localhost/api/v1/tasks/task-1/recurrence", { method: "DELETE" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );

    expect(resposta.status).toBe(409);
    const cancelamento = h.banco.cadeias.find(
      (cadeia) => cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "update",
    );
    expect(cancelamento?.passos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metodo: "eq", args: ["current_task_id", "task-1"] }),
        expect.objectContaining({ metodo: "eq", args: ["active", true] }),
        expect.objectContaining({
          metodo: "eq",
          args: ["updated_at", "2026-11-02T20:00:00.000Z"],
        }),
        expect.objectContaining({ metodo: "select", args: ["id"] }),
      ]),
    );
  });

  it("devolve not-found quando a série vinculada não existe", async () => {
    h.banco = bancoFalso((cadeia) => {
      if (cadeia.tabela === "crm_tasks") return { data: { recurrence_id: "serie-ausente" } };
      return { data: null };
    });
    const resposta = await DELETE(
      new NextRequest("http://localhost/api/v1/tasks/task-1/recurrence", { method: "DELETE" }),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    expect(resposta.status).toBe(404);
  });
});
