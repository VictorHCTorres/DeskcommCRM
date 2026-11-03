import { beforeEach, describe, expect, it, vi } from "vitest";

import { argumentos, bancoFalso, operacao } from "@/tests/helpers/banco-falso-da-cobranca";

const h = vi.hoisted(() => ({ audit: vi.fn(), atividade: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/tarefas/atividade", () => ({ registraAtividadeDaTarefa: h.atividade }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

import { gerarRecorrenciasDeTarefas } from "./gerar-recorrencia";

const RECORRENCIA = {
  id: "serie-1",
  organization_id: "org-1",
  current_task_id: "task-0",
  frequency: "daily",
  interval: 1,
  mode: "on_schedule",
  timezone: "UTC",
  next_run_at: "2026-11-02T10:00:00.000Z",
  next_due_at: null,
  generation: 0,
  active: true,
  created_by: "user-1",
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
};

beforeEach(() => vi.clearAllMocks());

describe("gerador de recorrência", () => {
  it("organizações suspensas não consomem o limite do lote", async () => {
    const operante = {
      ...RECORRENCIA,
      id: "operante",
      current_task_id: null,
      organizations: { status: "active" },
    };
    const banco = bancoFalso((cadeia) => {
      if (cadeia.tabela !== "crm_task_recurrences") return { data: null };
      const colunas = String(argumentos(cadeia, "select")?.[0]);
      return { data: colunas.includes("current_task:") ? [] : [operante] };
    });

    const resultado = await gerarRecorrenciasDeTarefas(
      banco.cliente as never,
      new Date("2026-11-02T12:00:00.000Z"),
      1,
    );

    expect(resultado.lidas).toBe(1);
    expect(resultado.puladas).toBe(1);
    const consultaVencidas = banco.cadeias.find(
      (cadeia) =>
        cadeia.tabela === "crm_task_recurrences" &&
        !String(argumentos(cadeia, "select")?.[0]).includes("current_task:"),
    );
    expect(consultaVencidas?.passos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metodo: "eq", args: ["organizations.status", "active"] }),
        expect.objectContaining({ metodo: "limit", args: [1] }),
      ]),
    );
    expect(banco.rpcs).toEqual([]);
  });

  it("reconcilia after_completion concluída sem tick após crash", async () => {
    const pendente = {
      ...RECORRENCIA,
      mode: "after_completion",
      next_run_at: null,
      next_due_at: null,
      organizations: { status: "active" },
      current_task: { status: "done", updated_at: "2026-11-01T08:00:00.000Z" },
    };
    const banco = bancoFalso((cadeia) => {
      if (
        cadeia.tabela === "crm_task_recurrences" &&
        String(argumentos(cadeia, "select")?.[0]).includes("current_task:")
      )
        return { data: [pendente] };
      return { data: [] };
    });
    const agora = new Date("2026-11-02T12:00:00.000Z");

    await gerarRecorrenciasDeTarefas(banco.cliente as never, agora, 10);

    const reconciliacao = banco.cadeias.find(
      (cadeia) =>
        cadeia.tabela === "crm_task_recurrences" &&
        operacao(cadeia) === "update" &&
        (argumentos(cadeia, "update")?.[0] as { next_due_at?: string })?.next_due_at,
    );
    expect(argumentos(reconciliacao!, "update")?.[0]).toEqual({
      next_run_at: agora.toISOString(),
      next_due_at: "2026-11-02T08:00:00.000Z",
    });
  });

  it("CAS perdido remove só a tarefa provisional que não virou current", async () => {
    const atual = {
      id: "task-0",
      organization_id: "org-1",
      title: "Rotina",
      description: null,
      due_date: "2026-11-02T10:00:00.000Z",
      priority: "medium",
      status: "done",
      lead_id: null,
      contact_id: null,
      demanda_id: null,
      assigned_to: null,
      created_by: "user-1",
      parent_task_id: null,
      recurrence_id: "serie-1",
      recurrence_generation: 0,
      recurrence_scheduled_for: "2026-11-02T10:00:00.000Z",
      created_at: "2026-11-01T00:00:00.000Z",
      updated_at: "2026-11-01T00:00:00.000Z",
    };
    const nova = { ...atual, id: "task-provisional", status: "pending", recurrence_generation: 1 };
    const banco = bancoFalso(
      (cadeia) => {
        if (
          cadeia.tabela === "crm_task_recurrences" &&
          String(argumentos(cadeia, "select")?.[0]).includes("current_task:")
        )
          return { data: [] };
        if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "select") {
          const colunas = argumentos(cadeia, "select")?.[0];
          return colunas === "current_task_id"
            ? { data: { current_task_id: "task-vencedora" } }
            : {
                data: [
                  {
                    ...RECORRENCIA,
                    mode: "after_completion",
                    next_due_at: "2026-11-10T10:00:00.000Z",
                    organizations: { status: "active" },
                  },
                ],
              };
        }
        if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "select") {
          const colunas = argumentos(cadeia, "select")?.[0];
          return colunas === "*"
            ? { data: atual }
            : { data: { due_date: atual.due_date, recurrence_scheduled_for: atual.due_date } };
        }
        if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "insert") {
          return { data: nova };
        }
        if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "update") {
          return { data: [] };
        }
        return { data: null };
      },
      () => ({ data: true }),
    );

    const resultado = await gerarRecorrenciasDeTarefas(
      banco.cliente as never,
      new Date("2026-11-02T12:00:00.000Z"),
      10,
    );

    expect(resultado.puladas).toBe(1);
    const insercao = banco.cadeias.find(
      (cadeia) => cadeia.tabela === "crm_tasks" && operacao(cadeia) === "insert",
    );
    expect(argumentos(insercao!, "insert")?.[0]).toMatchObject({
      due_date: "2026-11-10T10:00:00.000Z",
      recurrence_scheduled_for: "2026-11-10T10:00:00.000Z",
    });
    const remocao = banco.cadeias.find(
      (cadeia) => cadeia.tabela === "crm_tasks" && operacao(cadeia) === "delete",
    );
    expect(remocao?.passos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ metodo: "eq", args: ["id", "task-provisional"] }),
        expect.objectContaining({ metodo: "eq", args: ["organization_id", "org-1"] }),
        expect.objectContaining({ metodo: "eq", args: ["recurrence_id", "serie-1"] }),
        expect.objectContaining({ metodo: "eq", args: ["recurrence_generation", 1] }),
      ]),
    );
    expect(h.audit).not.toHaveBeenCalled();
    expect(h.atividade).not.toHaveBeenCalled();
  });
});
