import { describe, expect, it, vi } from "vitest";

import { LIMITES_DOS_ANEXOS_CLICKUP } from "./anexos-seguros";
import type { ClickUpAttachmentManifest } from "./cliente-v3";
import { processarAnexosClickUp } from "./processar-anexos";

function anexo(id: string, sizeBytes = 1): ClickUpAttachmentManifest {
  return {
    id,
    page_id: "p1",
    name: `${id}.txt`,
    size_bytes: sizeBytes,
    mime_type: "text/plain",
    download_url: `https://attachments.clickup.com/${id}`,
  };
}

describe("limites de anexos por Doc", () => {
  it("recusa a contagem antes de iniciar downloads", async () => {
    const baixar = vi.fn();
    const anexos = Array.from(
      { length: LIMITES_DOS_ANEXOS_CLICKUP.porDocumento + 1 },
      (_, indice) => anexo(String(indice)),
    );
    await expect(processarAnexosClickUp(anexos, baixar)).rejects.toThrow(
      "attachment_document_count_exceeded",
    );
    expect(baixar).not.toHaveBeenCalled();
  });

  it("recusa a soma declarada por documento", async () => {
    const baixar = vi.fn();
    await expect(
      processarAnexosClickUp(
        [anexo("a", LIMITES_DOS_ANEXOS_CLICKUP.bytesPorDocumento), anexo("b", 1)],
        baixar,
      ),
    ).rejects.toThrow("attachment_document_bytes_exceeded");
    expect(baixar).not.toHaveBeenCalled();
  });

  it("aplica o saldo do documento como teto do próximo download", async () => {
    const baixar = vi.fn(async (_url: string, opcoes?: { maxBytes?: number }) => ({
      bytes: Buffer.alloc(opcoes?.maxBytes === LIMITES_DOS_ANEXOS_CLICKUP.porArquivo ? 3 : 2),
      mime: "text/plain",
      urlFinal: "https://attachments.clickup.com/final",
    }));
    const resultado = await processarAnexosClickUp([anexo("a"), anexo("b")], baixar);
    expect(resultado).toHaveLength(2);
    expect(baixar).toHaveBeenNthCalledWith(
      1,
      expect.any(String),
      expect.objectContaining({ maxBytes: LIMITES_DOS_ANEXOS_CLICKUP.porArquivo }),
    );
  });
});
