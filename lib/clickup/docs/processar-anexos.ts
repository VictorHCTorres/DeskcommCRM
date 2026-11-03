import { baixarAnexoSeguro, LIMITES_DOS_ANEXOS_CLICKUP, type AnexoBaixado } from "./anexos-seguros";
import type { ClickUpAttachmentManifest } from "./cliente-v3";

export interface AnexoClickUpProcessado extends AnexoBaixado {
  id: string;
  pageId: string;
  name: string;
}

/**
 * Fronteira única dos anexos de um Doc. Os limites são conferidos antes e
 * durante o download: `size_bytes` é só uma pista fornecida pelo ClickUp.
 */
export async function processarAnexosClickUp(
  anexos: ClickUpAttachmentManifest[],
  baixar: typeof baixarAnexoSeguro = baixarAnexoSeguro,
): Promise<AnexoClickUpProcessado[]> {
  if (anexos.length > LIMITES_DOS_ANEXOS_CLICKUP.porDocumento) {
    throw new Error("attachment_document_count_exceeded");
  }

  const declarados = anexos.reduce((total, anexo) => total + Math.max(0, anexo.size_bytes ?? 0), 0);
  if (declarados > LIMITES_DOS_ANEXOS_CLICKUP.bytesPorDocumento) {
    throw new Error("attachment_document_bytes_exceeded");
  }

  const resultado: AnexoClickUpProcessado[] = [];
  let bytesDoDocumento = 0;
  for (const anexo of anexos) {
    if (!anexo.download_url) throw new Error("attachment_download_url_missing");
    const baixado = await baixar(anexo.download_url, {
      maxBytes: Math.min(
        LIMITES_DOS_ANEXOS_CLICKUP.porArquivo,
        LIMITES_DOS_ANEXOS_CLICKUP.bytesPorDocumento - bytesDoDocumento,
      ),
    });
    bytesDoDocumento += baixado.bytes.byteLength;
    if (bytesDoDocumento > LIMITES_DOS_ANEXOS_CLICKUP.bytesPorDocumento) {
      throw new Error("attachment_document_bytes_exceeded");
    }
    resultado.push({
      ...baixado,
      id: anexo.id,
      pageId: anexo.page_id,
      name: anexo.name,
    });
  }
  return resultado;
}
