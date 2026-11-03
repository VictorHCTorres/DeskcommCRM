import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  argumentos,
  bancoFalso,
  operacao,
  type BancoFalso,
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
vi.mock("@/lib/audit", () => ({
  audit: async () => undefined,
  isServiceRoleConfigured: () => false,
}));
vi.mock("@/lib/tarefas/atividade", () => ({ registraAtividadeDaTarefa: async () => undefined }));
vi.mock("@/lib/tarefas/vinculos", () => ({ conferirVinculosDaTarefa: async () => "ok" }));

import { PATCH } from "./route";

describe("conclusão de tarefa after_completion", () => {
  beforeEach(() => {
    h.banco = bancoFalso((cadeia) => {
      if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "select") {
        return { data: { status: "pending", recurrence_id: "serie-1" } };
      }
      if (cadeia.tabela === "crm_tasks" && operacao(cadeia) === "update") {
        return {
          data: {
            id: "task-1",
            organization_id: "org-1",
            title: "Rotina",
            description: null,
            due_date: null,
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
            recurrence_scheduled_for: "2026-11-02T12:00:00.000Z",
            created_at: "2026-11-01T00:00:00.000Z",
            updated_at: "2026-11-02T12:00:00.000Z",
          },
        };
      }
      if (cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "select") {
        return {
          data: {
            id: "serie-1",
            frequency: "daily",
            interval: 1,
            mode: "after_completion",
            timezone: "UTC",
            active: true,
            current_task_id: "task-1",
          },
        };
      }
      return { data: null };
    });
  });

  it("agenda tick imediato separado do prazo futuro da próxima ocorrência", async () => {
    const antes = Date.now();
    const resposta = await PATCH(
      new NextRequest("http://localhost/api/v1/tasks/task-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      }),
      { params: Promise.resolve({ id: "task-1" }) },
    );
    const depois = Date.now();

    expect(resposta.status).toBe(200);
    const tick = h.banco.cadeias.find(
      (cadeia) => cadeia.tabela === "crm_task_recurrences" && operacao(cadeia) === "update",
    );
    const payload = argumentos(tick!, "update")?.[0] as {
      next_run_at: string;
      next_due_at: string;
    };
    expect(Date.parse(payload.next_run_at)).toBeGreaterThanOrEqual(antes);
    expect(Date.parse(payload.next_run_at)).toBeLessThanOrEqual(depois);
    expect(Date.parse(payload.next_due_at) - Date.parse(payload.next_run_at)).toBeGreaterThan(
      86_390_000,
    );
    expect(tick?.passos).toContainEqual({ metodo: "is", args: ["next_run_at", null] });
  });
});
