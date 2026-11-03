import { describe, expect, it } from "vitest";

import { familiasDeTarefas, faixaDePrazo, type Tarefa } from "@/lib/tarefas/tipos";

const BASE: Tarefa = {
  id: "raiz",
  organization_id: "org",
  title: "Raiz",
  description: null,
  due_date: "2026-11-20T12:00:00.000Z",
  priority: "medium",
  status: "pending",
  lead_id: null,
  contact_id: null,
  demanda_id: null,
  assigned_to: null,
  created_by: null,
  created_at: "2026-11-01T00:00:00.000Z",
  updated_at: "2026-11-01T00:00:00.000Z",
};

describe("famílias de tarefas", () => {
  it("agrupa um nível e usa o prazo aberto mais urgente da família", () => {
    const filha = {
      ...BASE,
      id: "filha",
      title: "Filha urgente",
      parent_task_id: BASE.id,
      due_date: "2026-11-01T12:00:00.000Z",
    };
    const [familia] = familiasDeTarefas([BASE, filha]);
    expect(familia?.filhas.map((t) => t.id)).toEqual(["filha"]);
    expect(faixaDePrazo(familia!.prazoDaFamilia, new Date("2026-11-02T12:00:00.000Z"))).toBe(
      "atrasada",
    );
  });

  it("não faz uma filha desaparecer quando a raiz não veio na leitura", () => {
    const filha = { ...BASE, id: "filha-orfa", parent_task_id: "raiz-ausente" };
    const familias = familiasDeTarefas([filha]);
    expect(familias).toHaveLength(1);
    expect(familias[0]).toMatchObject({ raiz: { id: "filha-orfa" }, filhas: [], orfa: true });
  });
});
