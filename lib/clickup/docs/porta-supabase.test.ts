import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/database.types";

import { portaKnowledgeClickUpSupabase } from "./porta-supabase";

describe("porta atômica Docs → Knowledge", () => {
  it("usa a RPC com receipt durável por tenant/source/hash", async () => {
    const rpc = vi.fn(async () => ({ data: { emitted: true }, error: null }));
    const admin = { rpc } as unknown as SupabaseClient<Database>;
    const porta = portaKnowledgeClickUpSupabase(admin);
    await porta.emitirAtualizacao({
      organizationId: "00000000-0000-4000-8000-000000000001",
      sourceId: "00000000-0000-4000-8000-000000000002",
      contentHash: "a".repeat(64),
      sourceMetadata: { provider: "clickup" },
    });
    expect(rpc).toHaveBeenCalledWith("fn_emit_clickup_knowledge_update", {
      p_organization_id: "00000000-0000-4000-8000-000000000001",
      p_source_id: "00000000-0000-4000-8000-000000000002",
      p_content_hash: "a".repeat(64),
      p_metadata: { provider: "clickup" },
    });
  });

  it("não sobrescreve content_hash indexado e preserva status ready recebido", async () => {
    const upsert = vi.fn(
      async (_value: Record<string, unknown>, _options?: Record<string, unknown>) => ({
        error: null,
      }),
    );
    const admin = {
      from: vi.fn(() => ({ upsert })),
    } as unknown as SupabaseClient<Database>;
    const porta = portaKnowledgeClickUpSupabase(admin);
    await porta.criarOuAtualizarFonte({
      id: "00000000-0000-4000-8000-000000000002",
      organizationId: "00000000-0000-4000-8000-000000000001",
      name: "ClickUp · Manual",
      sourceMetadata: { clickup_content_hash: "a".repeat(64) },
      status: "ready",
      lastIndexStatus: "indexando",
    });
    const escrita = upsert.mock.calls[0]![0];
    expect(escrita).toMatchObject({ status: "ready" });
    expect(escrita).not.toHaveProperty("content_hash");
  });
});
