import { describe, expect, it } from "vitest";

import {
  canonicalClickUpRelations,
  CLICKUP_TASK_CONTEXT_MAX_BYTES,
  CLICKUP_TASK_CONTEXT_MAX_ITEMS,
  clickUpFidelityMetadata,
  clickUpPriorityToCrm,
  normalizeClickUpTags,
} from "./fidelidade";

describe("fidelidade operacional ClickUp", () => {
  it("mapeia prioridade sem inventar urgência e ordena tags deterministicamente", () => {
    expect(clickUpPriorityToCrm({ priority: "normal" })).toBe("medium");
    expect(clickUpPriorityToCrm({ priority: "urgent" })).toBe("urgent");
    expect(clickUpPriorityToCrm(null)).toBe("medium");
    expect(
      normalizeClickUpTags([
        { name: "VIP", tag_bg: "#fff" },
        { name: "alpha", tag_fg: "#000" },
        { name: "vip", tag_bg: "#f00" },
      ]),
    ).toEqual([
      { name: "alpha", color: "#000" },
      { name: "VIP", color: "#fff" },
    ]);
  });

  it("preserva datas, estimativa zero e proveniência sem e-mail de watcher", () => {
    const metadata = clickUpFidelityMetadata({
      start_date: "1710052200000",
      time_estimate: 0,
      time_spent: 12,
      watcher_ids: ["2", "1"],
      watcher_count: 2,
      archive_scope: "active_and_archived",
      provenance: { include_timl: true },
    });
    expect(metadata).toMatchObject({
      start_at: "2024-03-10T06:30:00.000Z",
      time_estimate_ms: 0,
      time_spent_ms: 12,
      watcher_ids: ["2", "1"],
      watcher_count: 2,
      archive_scope: "active_and_archived",
      provenance: { include_timl: true },
    });
    expect(JSON.stringify(metadata)).not.toContain("@");
  });

  it("preserva o contexto operacional completo sem persistir e-mail de assignee", () => {
    const metadata = clickUpFidelityMetadata(
      {
        space_id: "space-1",
        space_name: "Operação",
        folder_id: "folder-1",
        folder_name: "Comercial",
        list_id: "list-1",
        list_name: "Implantação",
        parent_id: "parent-1",
        status_id: "status-1",
        status_name: "Executando",
        status_type: "custom",
        assignees: [
          {
            email: "privado@example.com",
            source_user_id: "clickup-user-1",
            display_name: "Operador",
          },
        ],
        custom_fields: [
          {
            id: "field-1",
            name: "Segmento",
            type: "drop_down",
            value: "option-vip",
            selected_options: [{ id: "option-vip", label: "VIP" }],
          },
          { id: "field-empty", name: "Sem valor", type: "text", value: null },
        ],
        due_date: "1710052200000",
        date_done: "1710138600000",
        date_closed: "1710225000000",
        linked_tasks: [{ task_id: "task-1", link_id: "task-2", date_created: "1710052200000" }],
        dependencies: [{ task_id: "task-1", depends_on: "task-0" }],
        provenance: { source_list_ids: ["list-1", "list-2"], multiple_lists: true },
      },
      { workspaceId: "workspace-1", parentExternalId: "parent-1" },
    );
    expect(metadata).toMatchObject({
      schema_version: 1,
      hierarchy: {
        workspace_id: "workspace-1",
        space_id: "space-1",
        folder_id: "folder-1",
        list_id: "list-1",
        source_list_ids: ["list-1", "list-2"],
        multiple_lists: true,
      },
      status: { id: "status-1", name: "Executando", type: "custom" },
      assignees: [{ source_user_id: "clickup-user-1", display_name: "Operador" }],
      custom_fields: [
        {
          id: "field-1",
          name: "Segmento",
          type: "drop_down",
          value: "option-vip",
          selected_options: [{ id: "option-vip", label: "VIP" }],
        },
      ],
      parent_external_id: "parent-1",
      due_at: "2024-03-10T06:30:00.000Z",
      linked_tasks: [{ task_id: "task-1", link_id: "task-2" }],
      dependencies: [{ task_id: "task-1", depends_on: "task-0" }],
    });
    expect(JSON.stringify(metadata)).not.toContain("privado@example.com");
    expect(JSON.stringify(metadata)).not.toContain("field-empty");
  });

  it("usa a lista corrente como provenance quando o discovery não traz múltiplas listas", () => {
    expect(clickUpFidelityMetadata({ list_id: "list-only" }).hierarchy).toMatchObject({
      list_id: "list-only",
      source_list_ids: ["list-only"],
      multiple_lists: false,
    });
  });

  it("recusa contexto acima dos limites sem truncar silenciosamente", () => {
    expect(() =>
      clickUpFidelityMetadata({
        custom_fields: Array.from({ length: CLICKUP_TASK_CONTEXT_MAX_ITEMS + 1 }, (_, index) => ({
          id: `field-${index}`,
          value: index,
        })),
      }),
    ).toThrow("clickup_task_context_custom_fields_too_many");
    expect(() =>
      clickUpFidelityMetadata({
        custom_fields: [{ id: "field-large", value: "x".repeat(CLICKUP_TASK_CONTEXT_MAX_BYTES) }],
      }),
    ).toThrow("clickup_task_context_too_large");
  });

  it("reduz os dois lados de linked_tasks ao mesmo par canônico", () => {
    const one = canonicalClickUpRelations("a", {
      linked_tasks: [{ task_id: "a", link_id: "b" }],
    });
    const other = canonicalClickUpRelations("b", {
      linked_tasks: [{ task_id: "a", link_id: "b" }],
    });
    expect(one).toEqual(other);
    expect(one).toEqual([
      {
        relation_type: "linked",
        source_task_id: "a",
        target_task_id: "b",
        source_id: "linked:a:b",
      },
    ]);
  });
});
