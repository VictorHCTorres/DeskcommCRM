import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  autorizado: false,
  gerar: vi.fn(async () => ({ lidas: 1, geradas: 1, puladas: 0, falhas: 0 })),
  auditar: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth/cron-auth", () => ({ autorizaCron: () => h.autorizado }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/tarefas/gerar-recorrencia", () => ({
  gerarRecorrenciasDeTarefas: h.gerar,
}));
vi.mock("@/lib/audit", () => ({ audit: h.auditar }));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  h.autorizado = false;
});

describe("cron de recorrência de tarefas", () => {
  it("falha fechado antes de tocar o gerador", async () => {
    const resposta = await POST(
      new NextRequest("http://localhost/api/v1/cron/task-recurrence", { method: "POST" }),
    );
    expect(resposta.status).toBe(403);
    expect(h.gerar).not.toHaveBeenCalled();
  });

  it("roda lote autenticado e audita quando houve efeito", async () => {
    h.autorizado = true;
    const resposta = await POST(
      new NextRequest("http://localhost/api/v1/cron/task-recurrence", { method: "POST" }),
    );
    expect(resposta.status).toBe(200);
    expect(h.gerar).toHaveBeenCalledWith(expect.anything(), expect.any(Date), 100);
    expect(h.auditar).toHaveBeenCalledWith(
      expect.objectContaining({ action: "crm_task.updated", bypassedRls: true }),
    );
  });
});
