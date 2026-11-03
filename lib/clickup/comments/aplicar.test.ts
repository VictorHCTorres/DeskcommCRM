import { describe, expect, it, vi } from "vitest";

import { aplicarComentariosClickUp, type PortaDeComentariosClickUp } from "./aplicar";
import { normalizarComentarioClickUp } from "./normalizar";

function comentario(id: string, parent: string | null = null) {
  return normalizarComentarioClickUp({
    taskId: "task-source",
    parentCommentId: parent,
    raw: { id, date: "1730619000000", comment_text: id, user: { id: "u", username: "Autor" } },
  });
}

function porta(destino: Awaited<ReturnType<PortaDeComentariosClickUp["resolverDestino"]>>) {
  return {
    resolverDestino: vi.fn<PortaDeComentariosClickUp["resolverDestino"]>(async () => destino),
    encontrarMapping: vi.fn<PortaDeComentariosClickUp["encontrarMapping"]>(async () => null),
    gravarAtividadeHistorica: vi.fn<PortaDeComentariosClickUp["gravarAtividadeHistorica"]>(
      async () => undefined,
    ),
    gravarComentarioDeTask: vi.fn<PortaDeComentariosClickUp["gravarComentarioDeTask"]>(
      async () => undefined,
    ),
    registrarMapping: vi.fn<PortaDeComentariosClickUp["registrarMapping"]>(async () => undefined),
  } satisfies PortaDeComentariosClickUp;
}

describe("apply create-only dos comentários", () => {
  it("cria atividade histórica system no lead sem chamar efeitos laterais", async () => {
    const fake = porta({ kind: "lead", organizationId: "org", targetId: "lead" });
    await aplicarComentariosClickUp({
      workspaceId: "wk",
      comments: [comentario("c1")],
      porta: fake,
    });
    expect(fake.gravarAtividadeHistorica).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "clickup_comment_imported",
        actorKind: "system",
        performedAt: "2024-11-03T07:30:00.000Z",
        payload: expect.objectContaining({ historical_import: true }),
      }),
    );
    expect(fake.gravarComentarioDeTask).not.toHaveBeenCalled();
    expect(Object.keys(fake)).toEqual([
      "resolverDestino",
      "encontrarMapping",
      "gravarAtividadeHistorica",
      "gravarComentarioDeTask",
      "registrarMapping",
    ]);
  });

  it("grava pai antes da reply e usa parent composto de destino", async () => {
    const fake = porta({ kind: "task", organizationId: "org", targetId: "task" });
    await aplicarComentariosClickUp({
      workspaceId: "wk",
      comments: [comentario("r1", "c1"), comentario("c1")],
      porta: fake,
    });
    expect(fake.gravarComentarioDeTask).toHaveBeenCalledTimes(2);
    const pai = fake.gravarComentarioDeTask.mock.calls[0]![0];
    const reply = fake.gravarComentarioDeTask.mock.calls[1]![0];
    expect(pai.parentSourceCommentId).toBeNull();
    expect(reply.parentSourceCommentId).toBe("c1");
    expect(reply.readOnly).toBe(true);
  });

  it("bloqueia alvo ausente e conflito create-only", async () => {
    const semAlvo = porta(null);
    await expect(
      aplicarComentariosClickUp({
        workspaceId: "wk",
        comments: [comentario("c1")],
        porta: semAlvo,
      }),
    ).resolves.toEqual([
      { commentId: "c1", outcome: "blocked", reason: "blocked_parent_not_mapped" },
    ]);
    expect(semAlvo.gravarAtividadeHistorica).not.toHaveBeenCalled();

    const conflito = porta({ kind: "task", organizationId: "org", targetId: "task" });
    conflito.encontrarMapping.mockResolvedValue({
      sourceHash: "hash-diferente",
      destinationId: "dest",
      targetKind: "task",
      targetId: "task",
    });
    await expect(
      aplicarComentariosClickUp({
        workspaceId: "wk",
        comments: [comentario("c1")],
        porta: conflito,
      }),
    ).resolves.toEqual([
      { commentId: "c1", outcome: "conflict", reason: "clickup_comment_create_only_conflict" },
    ]);
    expect(conflito.gravarComentarioDeTask).not.toHaveBeenCalled();
  });
});
