import { describe, expect, it } from "vitest";

import { deriveClickUpCrmLists } from "./_clickup-import";

describe("editor de mapping ClickUp CRM", () => {
  it("deriva List, hierarquia, statuses e fields sem JSON de mapping externo", () => {
    const lists = deriveClickUpCrmLists({
      objects: [
        { source_type: "space", source_id: "s1", metadata: { name: "Comercial" } },
        {
          source_type: "folder",
          source_id: "f1",
          parent_source_id: "s1",
          metadata: { name: "Inbound" },
        },
        {
          source_type: "list",
          source_id: "l1",
          parent_source_id: "f1",
          metadata: { name: "Vendas" },
        },
        {
          source_type: "status",
          source_id: "st1",
          parent_source_id: "l1",
          metadata: { name: "Closed" },
        },
        {
          source_type: "custom_field",
          source_id: "cf1",
          parent_source_id: "l1",
          metadata: {
            name: "Opção",
            type: "drop_down",
            type_config: { options: [{ id: "opt-1", name: "Primeira" }] },
          },
        },
        {
          source_type: "custom_field",
          source_id: "cf2",
          parent_source_id: "l1",
          metadata: { name: "Fórmula", type: "formula" },
        },
      ],
    });
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({
      list_id: "l1",
      space_id: "s1",
      folder_id: "f1",
      mode: "crm_leads",
      area_name: "Comercial",
      group_name: "Inbound",
      pipeline_name: "Vendas",
      statuses: [{ status_id: "st1", terminal: "open" }],
      fields: [
        {
          field_id: "cf1",
          action: "native",
          target_type: "dropdown",
          options: [{ id: "opt-1", label: "Primeira" }],
        },
        { field_id: "cf2", action: "text", target_type: "text" },
      ],
    });
  });

  it("deriva o inventário paginado do staging sem receber payload de tasks", () => {
    const lists = deriveClickUpCrmLists({
      objects: [
        {
          entity_type: "list",
          external_id: "l-stage",
          parent_external_id: "s-stage",
          source_metadata: { name: "Funil staged", space_id: "s-stage" },
        },
        {
          entity_type: "status",
          external_id: "l-stage:open",
          parent_external_id: "l-stage",
          source_metadata: {
            list_id: "l-stage",
            source_status_id: "open",
            name: "Aberto",
          },
        },
      ],
    });
    expect(lists[0]).toMatchObject({
      list_id: "l-stage",
      statuses: [{ status_id: "open", name: "Aberto" }],
    });
  });
});
