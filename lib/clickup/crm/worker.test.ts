import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/clickup/comments/worker", () => ({ applyClickUpCommentItem: vi.fn() }));
vi.mock("@/lib/clickup/crm/aplicar", () => ({ applyClickUpCrmItem: vi.fn() }));

import { applyClickUpCommentItem } from "@/lib/clickup/comments/worker";
import { applyClickUpCrmItem } from "@/lib/clickup/crm/aplicar";

import { applyClickUpCrmWorkerItem } from "./worker";

describe("dispatch de itens do worker CRM", () => {
  const db = {} as SupabaseClient;
  const run = { organization_id: "org", workspace_id: "wk" };

  beforeEach(() => vi.clearAllMocks());

  it("encaminha comment ao adapter histórico, sem cair no skipped genérico", async () => {
    vi.mocked(applyClickUpCommentItem).mockResolvedValue("succeeded");
    await expect(
      applyClickUpCrmWorkerItem(db, run, { entity_type: "comment", external_id: "c1" }),
    ).resolves.toBe("succeeded");
    expect(applyClickUpCommentItem).toHaveBeenCalledOnce();
    expect(applyClickUpCrmItem).not.toHaveBeenCalled();
  });

  it("mantém entidades CRM no aplicador canônico", async () => {
    vi.mocked(applyClickUpCrmItem).mockResolvedValue("unchanged");
    await expect(
      applyClickUpCrmWorkerItem(db, run, { entity_type: "task", external_id: "t1" }),
    ).resolves.toBe("unchanged");
    expect(applyClickUpCrmItem).toHaveBeenCalledOnce();
  });
});
