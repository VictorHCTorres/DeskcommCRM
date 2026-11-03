import { describe, expect, it, vi } from "vitest";

import {
  idDaFonteClickUp,
  ingerirDocClickUp,
  pathDoMarkdownClickUp,
  type EscritaDaFonteClickUp,
  type FonteClickUpExistente,
  type PortaKnowledgeClickUp,
} from "./ingestao";

const base = {
  organizationId: "org-1",
  connectionId: "conn-1",
  workspaceId: "wk-1",
  docId: "doc-1",
  name: "Manual",
  markdown: "# Manual\n\nConteúdo",
  private: false,
  privateExplicitlyAuthorized: false,
  attachmentManifest: [],
  importedBy: "user-1",
};

function porta(existente: FonteClickUpExistente | null = null) {
  return {
    encontrarFonte: vi.fn(async () => existente),
    guardarMarkdown: vi.fn(
      async (_input: Parameters<PortaKnowledgeClickUp["guardarMarkdown"]>[0]) => undefined,
    ),
    criarOuAtualizarFonte: vi.fn(async (_input: EscritaDaFonteClickUp) => undefined),
    emitirAtualizacao: vi.fn(
      async (_input: Parameters<PortaKnowledgeClickUp["emitirAtualizacao"]>[0]) => undefined,
    ),
  } satisfies PortaKnowledgeClickUp;
}

describe("Docs ClickUp → Knowledge", () => {
  it("mantém identidade e blob determinísticos por Doc/versão", () => {
    expect(idDaFonteClickUp("o", "c", "d")).toBe(idDaFonteClickUp("o", "c", "d"));
    expect(pathDoMarkdownClickUp("o", "c", "d", "a".repeat(64))).toMatch(
      /^o\/clickup\/[0-9a-f]{32}\/a{64}\.md$/,
    );
  });

  it("cria uma fonte documento em building e enfileira a indexação", async () => {
    const fake = porta();
    const resultado = await ingerirDocClickUp(base, fake, true);
    expect(resultado.kind).toBe("queued");
    expect(fake.guardarMarkdown).toHaveBeenCalledOnce();
    expect(fake.criarOuAtualizarFonte).toHaveBeenCalledWith(
      expect.objectContaining({ status: "building", lastIndexStatus: "indexando" }),
    );
    expect(fake.emitirAtualizacao).toHaveBeenCalledOnce();
  });

  it("sem credencial fica pending e nunca false-ready", async () => {
    const fake = porta();
    await expect(ingerirDocClickUp(base, fake, false)).resolves.toMatchObject({
      kind: "indexing_pending",
      reason: "sem_credencial",
    });
    expect(fake.criarOuAtualizarFonte).toHaveBeenCalledWith(
      expect.objectContaining({ status: "building", lastIndexStatus: "sem_credencial" }),
    );
  });

  it("rerun unchanged não grava blob/fonte e delega dedup atômico à RPC", async () => {
    const primeira = porta();
    await ingerirDocClickUp(base, primeira, true);
    const escrita = primeira.criarOuAtualizarFonte.mock.calls[0]?.[0];
    expect(escrita).toBeDefined();
    const fake = porta({
      id: escrita!.id,
      status: "building",
      activeKbVersionId: null,
      sourceMetadata: escrita!.sourceMetadata,
    });
    await expect(ingerirDocClickUp(base, fake, true)).resolves.toMatchObject({ kind: "unchanged" });
    expect(fake.guardarMarkdown).not.toHaveBeenCalled();
    expect(fake.criarOuAtualizarFonte).not.toHaveBeenCalled();
    expect(fake.emitirAtualizacao).toHaveBeenCalledOnce();
  });

  it("retoma o evento após crash entre a fonte e a emissão sem reupload", async () => {
    const primeira = porta();
    await ingerirDocClickUp(base, primeira, true);
    const escrita = primeira.criarOuAtualizarFonte.mock.calls[0]![0];
    const fake = porta({
      id: escrita.id,
      status: "building",
      activeKbVersionId: null,
      sourceMetadata: escrita.sourceMetadata,
    });
    await ingerirDocClickUp(base, fake, true);
    expect(fake.guardarMarkdown).not.toHaveBeenCalled();
    expect(fake.emitirAtualizacao).toHaveBeenCalledOnce();
  });

  it("retry após resposta perdida não duplica o evento atômico", async () => {
    const primeira = porta();
    await ingerirDocClickUp(base, primeira, true);
    const escrita = primeira.criarOuAtualizarFonte.mock.calls[0]![0];
    const receipts = new Set<string>();
    let eventos = 0;
    let perderResposta = true;
    const fake = porta({
      id: escrita.id,
      status: "building",
      activeKbVersionId: null,
      sourceMetadata: escrita.sourceMetadata,
    });
    fake.emitirAtualizacao.mockImplementation(async ({ contentHash }) => {
      if (!receipts.has(contentHash)) {
        receipts.add(contentHash);
        eventos += 1;
      }
      if (perderResposta) {
        perderResposta = false;
        throw new Error("conexao_caiu_apos_commit");
      }
    });
    await expect(ingerirDocClickUp(base, fake, true)).rejects.toThrow("conexao_caiu_apos_commit");
    await expect(ingerirDocClickUp(base, fake, true)).resolves.toMatchObject({ kind: "unchanged" });
    expect(eventos).toBe(1);
    expect(fake.guardarMarkdown).not.toHaveBeenCalled();
  });

  it("preserva a fonte anterior até o indexador ativar a nova versão", async () => {
    const fake = porta({
      id: "fonte",
      status: "ready",
      activeKbVersionId: "versao-ativa",
      sourceMetadata: { clickup_content_hash: "b".repeat(64) },
    });
    await ingerirDocClickUp(base, fake, true);
    expect(fake.criarOuAtualizarFonte).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ready" }),
    );
    expect(fake.criarOuAtualizarFonte.mock.calls[0]?.[0]).not.toHaveProperty("contentHash");
  });

  it("recusa Doc privado sem autorização administrativa explícita", async () => {
    const fake = porta();
    await expect(ingerirDocClickUp({ ...base, private: true }, fake, true)).rejects.toThrow(
      "clickup_private_doc_requires_admin",
    );
    expect(fake.guardarMarkdown).not.toHaveBeenCalled();
  });
});
