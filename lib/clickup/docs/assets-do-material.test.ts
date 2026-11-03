import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { listarAssetsDoMaterialClickUp } from "./assets-do-material";

describe("assets ClickUp do material", () => {
  it("escopa organização e fonte e não lê bytes nem URL", async () => {
    const order = vi.fn(async () => ({
      data: [{ id: "a", file_name: "manual.pdf", file_size: 10, mime_type: "application/pdf" }],
      error: null,
    }));
    const eqSource = vi.fn(() => ({ order }));
    const eqOrg = vi.fn(() => ({ eq: eqSource }));
    const select = vi.fn(() => ({ eq: eqOrg }));
    const from = vi.fn(() => ({ select }));
    const assets = await listarAssetsDoMaterialClickUp({ from } as unknown as SupabaseClient, {
      organizationId: "org",
      sourceId: "source",
    });
    expect(from).toHaveBeenCalledWith("ai_knowledge_source_attachments");
    expect(select).toHaveBeenCalledWith("id, file_name, file_size, mime_type, source_revision");
    expect(eqOrg).toHaveBeenCalledWith("organization_id", "org");
    expect(eqSource).toHaveBeenCalledWith("knowledge_source_id", "source");
    expect(assets[0]?.file_name).toBe("manual.pdf");
    expect(assets[0]?.media_href).toBe("/api/v1/ai/knowledge/sources/source/attachments/a/media");
  });
});
