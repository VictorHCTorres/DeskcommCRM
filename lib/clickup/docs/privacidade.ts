import type { ClickUpManifest } from "@/lib/clickup/contrato";

function registro(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

export function estadoDaPrivacidadeDosDocs(manifest: ClickUpManifest): {
  temPrivado: boolean;
  inclusaoExplicita: boolean;
} {
  const privados = manifest.objects.filter((objeto) => {
    if (objeto.source_type !== "doc" && objeto.source_type !== "doc_page") return false;
    const metadata = registro(objeto.metadata);
    return (
      metadata.private === true ||
      ["PRIVATE", "RESTRICTED"].includes(String(metadata.visibility ?? "").toUpperCase())
    );
  });
  return {
    temPrivado: privados.length > 0,
    inclusaoExplicita:
      privados.length > 0 &&
      privados.every((objeto) => registro(objeto.metadata).private_scope_explicit === true),
  };
}

export const AVISO_DOC_PRIVADO_CLICKUP =
  "Docs privados/restritos importados ficam disponíveis no Knowledge para toda a organização.";
