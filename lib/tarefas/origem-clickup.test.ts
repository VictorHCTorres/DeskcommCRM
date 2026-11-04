import { describe, expect, it } from "vitest";

import { catalogoClickUpDasTarefas, origemClickUpDaTarefa } from "./origem-clickup";

const metadata = {
  segredo_interno: "não sai",
  clickup: {
    schema_version: 1,
    hierarchy: {
      workspace_id: "ws-1",
      space_id: "space-1",
      space_name: "Financeiro",
      folder_id: "folder-1",
      folder_name: "Contas",
      list_id: "list-1",
      list_name: "A pagar",
    },
    status: { id: "status-1", name: "Atrasado", type: "custom" },
    assignees: [{ source_user_id: "user-1", display_name: "Pessoa A", email: "nao@sai.test" }],
    time_spent_ms: 3_600_000,
    custom_fields: [
      {
        id: "servico",
        name: "Serviço",
        type: "drop_down",
        value: "option-1",
        selected_options: [{ id: "option-1", label: "Registro de marca" }],
      },
    ],
  },
};

describe("origem ClickUp da tarefa", () => {
  it("expõe só o contexto operacional necessário, sem payload cru nem e-mail", () => {
    const origem = origemClickUpDaTarefa(metadata);
    expect(origem).toEqual({
      workspace_id: "ws-1",
      space_id: "space-1",
      space_name: "Financeiro",
      folder_id: "folder-1",
      folder_name: "Contas",
      list_id: "list-1",
      list_name: "A pagar",
      status: { id: "status-1", name: "Atrasado", type: "custom" },
      assignees: [{ source_user_id: "user-1", display_name: "Pessoa A" }],
      custom_fields: [
        {
          id: "servico",
          name: "Serviço",
          type: "drop_down",
          value: "option-1",
          selected_options: [{ id: "option-1", label: "Registro de marca" }],
        },
      ],
      time_spent_ms: 3_600_000,
    });
    expect(JSON.stringify(origem)).not.toContain("nao@sai.test");
    expect(JSON.stringify(origem)).not.toContain("segredo_interno");
  });

  it("conta e ordena as coleções a partir das tarefas realmente importadas", () => {
    expect(
      catalogoClickUpDasTarefas([
        metadata,
        metadata,
        {
          clickup: {
            hierarchy: {
              space_id: "space-2",
              space_name: "Conteúdo",
              list_id: "list-2",
              list_name: "Radar",
            },
            status: { name: "Ideia" },
          },
        },
      ]),
    ).toEqual([
      expect.objectContaining({ list_id: "list-2", tasks: 1 }),
      expect.objectContaining({ list_id: "list-1", tasks: 2 }),
    ]);
  });

  it("não inventa origem quando o envelope está incompleto", () => {
    expect(origemClickUpDaTarefa({ clickup: { hierarchy: { list_id: "x" } } })).toBeNull();
  });
});
