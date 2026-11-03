import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { aplicarDocClickUp } from "./aplicar";
import type { PortaKnowledgeClickUp } from "./ingestao";

function banco() {
  const upsert = vi.fn(async () => ({ error: null }));
  return {
    db: { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient,
    upsert,
  };
}

function porta(): PortaKnowledgeClickUp {
  return {
    encontrarFonte: vi.fn(async () => null),
    guardarMarkdown: vi.fn(async () => undefined),
    criarOuAtualizarFonte: vi.fn(async () => undefined),
    emitirAtualizacao: vi.fn(async () => undefined),
  };
}

const run = {
  organization_id: "org",
  connection_id: "conn",
  workspace_id: "wk",
  created_by: "user",
  mapping_revision: 1,
  dry_run: false,
};

const item = {
  entity_type: "doc",
  external_id: "doc",
  source_hash: "hash",
  source_payload: { format: "markdown", content: "# Conteúdo" },
  source_metadata: { name: "Manual", attachment_manifest: [] },
};

describe("aplicação do item Doc", () => {
  it("cria a fonte e o mapping determinístico", async () => {
    const { db, upsert } = banco();
    const resultado = await aplicarDocClickUp(db, run, item, {
      temChave: async () => true,
      porta: porta(),
    });
    expect(resultado).toBe("succeeded");
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: "org",
        entity_type: "doc",
        external_id: "doc",
        knowledge_source_id: expect.any(String),
      }),
      { onConflict: "organization_id,workspace_id,entity_type,external_id" },
    );
  });

  it("dry-run não toca Knowledge nem mapping", async () => {
    const { db, upsert } = banco();
    const fake = porta();
    await expect(
      aplicarDocClickUp(db, { ...run, dry_run: true }, item, {
        temChave: async () => true,
        porta: fake,
      }),
    ).resolves.toBe("succeeded");
    expect(fake.guardarMarkdown).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
  });

  it("falha fechado para privado sem inclusão explícita", async () => {
    const { db } = banco();
    await expect(
      aplicarDocClickUp(
        db,
        run,
        { ...item, source_metadata: { private: true, attachment_manifest: [] } },
        { temChave: async () => true, porta: porta() },
      ),
    ).rejects.toThrow("clickup_private_doc_requires_admin");
  });
});
