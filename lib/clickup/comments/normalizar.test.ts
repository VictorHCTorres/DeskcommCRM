import { describe, expect, it } from "vitest";

import {
  hashDoComentario,
  normalizarComentarioClickUp,
  ordenarComentariosComReplies,
  sanitizarComentarioMarkdown,
} from "./normalizar";

describe("comentários ClickUp sanitizados", () => {
  it("remove HTML ativo, imagens, schemes ativos e torna mentions inertes", () => {
    expect(
      sanitizarComentarioMarkdown(
        "<script>alert(1)</script><b>Oi</b> @Ana ![x](https://pixel) [clique](javascript:alert(1))",
      ),
    ).toBe("Oi ＠Ana x clique)");
  });

  it("não persiste e-mail do autor, URL nem campos extras", () => {
    const comentario = normalizarComentarioClickUp({
      taskId: "t1",
      raw: {
        id: "c1",
        date: "1730619000000",
        user: { id: 7, username: "Ana ana@example.com", email: "ana@example.com" },
        comment_text: "Olá",
        url: "https://signed.example/token",
        attachments: [{ id: "a1", url: "https://signed.example/asset" }],
      },
    });
    expect(comentario.author).toEqual({
      source_user_id: "7",
      display_name: "Ana [e-mail removido]",
    });
    expect(comentario.attachment_ids).toEqual(["a1"]);
    expect(JSON.stringify(comentario)).not.toContain("signed.example");
    expect(hashDoComentario(comentario)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ordena empate por ID e sempre põe reply depois do pai", () => {
    const fazer = (id: string, parent: string | null) =>
      normalizarComentarioClickUp({
        taskId: "t1",
        parentCommentId: parent,
        raw: { id, date: "1730619000000", comment_text: id },
      });
    expect(
      ordenarComentariosComReplies([fazer("r1", "c2"), fazer("c2", null), fazer("c1", null)]).map(
        (item) => item.comment_id,
      ),
    ).toEqual(["c1", "c2", "r1"]);
  });
});
