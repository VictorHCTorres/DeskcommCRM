import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { listClickUpRelations } from "./relations";

function query(result: { data: unknown[]; error: null }) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    or: vi.fn(() => builder),
    in: vi.fn(() => builder),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(resolve(result)),
  };
  return builder;
}

describe("listClickUpRelations", () => {
  it("filtra todas as leituras por organização e projeta só o destino seguro", async () => {
    const relations = query({
      data: [
        {
          id: "rel-1",
          relation_type: "linked",
          left_task_id: "00000000-0000-4000-8000-000000000001",
          right_task_id: "00000000-0000-4000-8000-000000000002",
          source_external_id: "não-deve-sair",
        },
      ],
      error: null,
    });
    const tasks = query({
      data: [{ id: "00000000-0000-4000-8000-000000000002", title: "Destino" }],
      error: null,
    });
    const db = {
      from: vi.fn((table: string) => (table === "crm_clickup_relations" ? relations : tasks)),
    } as unknown as SupabaseClient;
    const result = await listClickUpRelations(db, {
      organizationId: "org-segura",
      entity: { kind: "task", id: "00000000-0000-4000-8000-000000000001" },
    });
    expect(result).toEqual([
      {
        id: "rel-1",
        relation_type: "linked",
        target: {
          kind: "task",
          id: "00000000-0000-4000-8000-000000000002",
          title: "Destino",
        },
      },
    ]);
    expect(relations.eq).toHaveBeenCalledWith("organization_id", "org-segura");
    expect(tasks.eq).toHaveBeenCalledWith("organization_id", "org-segura");
    expect(JSON.stringify(result)).not.toContain("não-deve-sair");
  });
});
