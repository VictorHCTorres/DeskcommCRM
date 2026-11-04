import { describe, expect, it } from "vitest";

import {
  checklistToMarkdown,
  clickupAssigneeEmail,
  clickupCrmMappingConfigSchema,
  clickupCustomFieldKey,
  validateEveryListIsMapped,
} from "./contrato";

const baseList = {
  list_id: "list-1",
  space_id: "space-1",
  folder_id: "folder-1",
  pipeline_key: "pipeline-vendas",
  mode: "crm_leads" as const,
  area_name: "Comercial",
  group_name: "Inbound",
  pipeline_name: "Vendas",
  statuses: [
    { status_id: "novo", name: "Novo", terminal: "open" as const },
    { status_id: "ganho", name: "Ganho", terminal: "won" as const },
  ],
  fields: [],
};

describe("contrato CRM da importação ClickUp", () => {
  it("exige decisão explícita para todas as Lists", () => {
    const mapping = clickupCrmMappingConfigSchema.parse({
      lists: [baseList, { list_id: "list-2", mode: "crm_tasks", import_subtasks: true }],
    });
    expect(validateEveryListIsMapped(["list-1", "list-2"], mapping)).toEqual({
      ok: true,
      missing: [],
    });
    expect(validateEveryListIsMapped(["list-1", "list-2", "list-3"], mapping)).toEqual({
      ok: false,
      missing: ["list-3"],
    });
  });

  it("bloqueia perda silenciosa de Lists ou subtarefas", () => {
    expect(
      clickupCrmMappingConfigSchema.safeParse({
        lists: [{ list_id: "list-1", mode: "ignore", import_subtasks: true }],
      }).success,
    ).toBe(false);
    expect(
      clickupCrmMappingConfigSchema.safeParse({
        lists: [{ ...baseList, import_subtasks: false }],
      }).success,
    ).toBe(false);
  });

  it("não infere won/lost e recusa tipo avançado sem text/ignore explícito", () => {
    expect(
      clickupCrmMappingConfigSchema.safeParse({
        lists: [
          { ...baseList, statuses: [{ status_id: "closed", name: "Closed", terminal: "open" }] },
        ],
      }).success,
    ).toBe(true);
    expect(
      clickupCrmMappingConfigSchema.safeParse({
        lists: [
          {
            ...baseList,
            fields: [
              {
                field_id: "formula-1",
                label: "Score",
                source_type: "formula",
                action: "native",
                target_type: "number",
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("aplica hard gate de 50 campos por pipeline", () => {
    const fields = Array.from({ length: 51 }, (_, index) => ({
      field_id: `field-${index}`,
      label: `Campo ${index}`,
      source_type: "text",
      action: "native" as const,
      target_type: "text" as const,
    }));
    expect(
      clickupCrmMappingConfigSchema.safeParse({ lists: [{ ...baseList, fields }] }).success,
    ).toBe(false);
  });

  it("soma o teto entre Lists do mesmo pipeline e aceita campo user", () => {
    const fields = (prefix: string, size: number) =>
      Array.from({ length: size }, (_, index) => ({
        field_id: `${prefix}-${index}`,
        label: `Campo ${prefix} ${index}`,
        source_type: index === 0 ? "user" : "text",
        action: "native" as const,
        target_type: index === 0 ? ("user" as const) : ("text" as const),
      }));
    expect(
      clickupCrmMappingConfigSchema.safeParse({
        lists: [
          { ...baseList, list_id: "a", fields: fields("a", 30) },
          { ...baseList, list_id: "b", fields: fields("b", 21) },
        ],
      }).success,
    ).toBe(false);
    expect(
      clickupCrmMappingConfigSchema.safeParse({
        lists: [{ ...baseList, fields: fields("a", 1) }],
      }).success,
    ).toBe(true);
  });

  it("labels e dropdowns exigem opções estáveis no mapping", () => {
    const field = {
      field_id: "labels-1",
      label: "Tags",
      source_type: "labels",
      action: "native" as const,
      target_type: "labels" as const,
    };
    expect(
      clickupCrmMappingConfigSchema.safeParse({ lists: [{ ...baseList, fields: [field] }] })
        .success,
    ).toBe(false);
    expect(
      clickupCrmMappingConfigSchema.safeParse({
        lists: [
          {
            ...baseList,
            fields: [{ ...field, options: [{ id: "vip", label: "VIP" }] }],
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("múltiplos assignees seguem estratégia explícita, nunca criam identidade", () => {
    const metadata = { assignees: [{ email: "UM@EXAMPLE.COM" }, { email: "dois@example.com" }] };
    expect(clickupAssigneeEmail(metadata, "unassigned")).toBeNull();
    expect(clickupAssigneeEmail(metadata, "first")).toBe("um@example.com");
  });

  it("gera chave estável e converte checklist em Markdown", () => {
    expect(clickupCustomFieldKey("field-123")).toMatch(/^cu_[0-9a-f]{20}$/);
    expect(clickupCustomFieldKey("field-123")).toBe(clickupCustomFieldKey("field-123"));
    expect(
      checklistToMarkdown([
        { name: "Conferir contrato", resolved: true },
        { name: "Retornar cliente" },
      ]),
    ).toBe("- [x] Conferir contrato\n- [ ] Retornar cliente");
  });

  it("valida a escala contratada de 48 Lists, 1.983 tasks e 145 fields", () => {
    const lists = Array.from({ length: 48 }, (_, listIndex) => ({
      ...baseList,
      list_id: `list-${listIndex}`,
      pipeline_key: `pipeline-${listIndex}`,
      pipeline_name: `Pipeline ${listIndex}`,
      fields: Array.from({ length: listIndex === 47 ? 4 : 3 }, (_, fieldIndex) => ({
        field_id: `field-${listIndex}-${fieldIndex}`,
        label: `Campo ${listIndex}/${fieldIndex}`,
        source_type: "text",
        action: "native" as const,
        target_type: "text" as const,
      })),
    }));
    const taskListIds = Array.from({ length: 1_983 }, (_, index) => `list-${index % 48}`);
    const parsed = clickupCrmMappingConfigSchema.parse({ lists });
    expect(lists.flatMap((list) => list.fields)).toHaveLength(145);
    expect(taskListIds).toHaveLength(1_983);
    expect(validateEveryListIsMapped(taskListIds, parsed)).toEqual({ ok: true, missing: [] });
  });
});
