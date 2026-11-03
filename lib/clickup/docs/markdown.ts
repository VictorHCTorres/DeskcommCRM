type RichNode = {
  type?: string;
  text?: string;
  content?: unknown;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
};

function normalizarTexto(texto: string): string {
  return texto
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((linha) => linha.replace(/[ \t]+$/g, ""))
    .join("\n");
}

function escaparInline(texto: string): string {
  return texto.replace(/([\\`*_[\]<>])/g, "\\$1");
}

function aplicarMarcas(texto: string, marcas: RichNode["marks"]): string {
  return [...(marcas ?? [])]
    .sort((a, b) => String(a.type).localeCompare(String(b.type)))
    .reduce((atual, marca) => {
      if (marca.type === "bold") return `**${atual}**`;
      if (marca.type === "italic") return `*${atual}*`;
      if (marca.type === "strike") return `~~${atual}~~`;
      if (marca.type === "code") return `\`${atual.replace(/`/g, "\\`")}\``;
      if (marca.type === "link") {
        const href = typeof marca.attrs?.href === "string" ? marca.attrs.href : "";
        return href ? `[${atual}](${href.replace(/[()\s]/g, encodeURIComponent)})` : atual;
      }
      return atual;
    }, texto);
}

function filhos(node: RichNode): RichNode[] {
  return Array.isArray(node.content) ? (node.content as RichNode[]) : [];
}

function inline(node: RichNode): string {
  if (node.type === "text" || (!node.type && typeof node.text === "string")) {
    return aplicarMarcas(escaparInline(node.text ?? ""), node.marks);
  }
  if (node.type === "hard_break") return "  \n";
  return filhos(node).map(inline).join("");
}

export interface AvisoDeConversaoClickUp {
  path: string;
  type: string;
  code: "unsupported_rich_text_block" | "html_sanitized" | "attachment_skipped_not_imported";
}

function textoDoHtml(valor: string): string {
  return valor
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function bloco(
  node: RichNode,
  nivel = 0,
  avisos: AvisoDeConversaoClickUp[] = [],
  path = "$",
): string {
  const conteudo = filhos(node);
  const blocosFilhos = (separador = "\n\n") =>
    conteudo
      .map((filho, indice) => bloco(filho, nivel, avisos, `${path}.content[${indice}]`))
      .join(separador);
  if (node.type === "doc") return blocosFilhos();
  if (node.type === "heading") {
    const grauBruto = Number(node.attrs?.level ?? 2);
    const grau = Math.min(6, Math.max(1, Number.isFinite(grauBruto) ? grauBruto : 2));
    return `${"#".repeat(grau)} ${conteudo.map(inline).join("").trim()}`;
  }
  if (node.type === "paragraph") return conteudo.map(inline).join("").trimEnd();
  if (node.type === "blockquote") {
    return conteudo
      .map((filho, indice) => bloco(filho, nivel, avisos, `${path}.content[${indice}]`))
      .join("\n\n")
      .split("\n")
      .map((linha) => `> ${linha}`.trimEnd())
      .join("\n");
  }
  if (node.type === "code_block") {
    const linguagem = typeof node.attrs?.language === "string" ? node.attrs.language : "";
    const codigo = conteudo.map((filho) => filho.text ?? inline(filho)).join("");
    return `\`\`\`${linguagem}\n${normalizarTexto(codigo)}\n\`\`\``;
  }
  if (node.type === "bullet_list" || node.type === "ordered_list") {
    return conteudo
      .map((item, indice) => {
        const prefixo = node.type === "ordered_list" ? `${indice + 1}. ` : "- ";
        const corpo = bloco(item, nivel + 1, avisos, `${path}.content[${indice}]`).replace(
          /\n/g,
          `\n${"  ".repeat(nivel + 1)}`,
        );
        return `${"  ".repeat(nivel)}${prefixo}${corpo}`;
      })
      .join("\n");
  }
  if (node.type === "list_item") return blocosFilhos("\n");
  if (node.type === "horizontal_rule") return "---";
  if (node.type === "table") {
    const linhas = conteudo.map((linha, indice) =>
      filhos(linha).map((celula, coluna) =>
        bloco(celula, nivel, avisos, `${path}.content[${indice}].content[${coluna}]`)
          .replace(/\|/g, "\\|")
          .replace(/\n+/g, " ")
          .trim(),
      ),
    );
    if (!linhas.length) return "";
    const colunas = Math.max(...linhas.map((linha) => linha.length));
    const normalizada = linhas.map((linha) => [
      ...linha,
      ...Array(colunas - linha.length).fill(""),
    ]);
    const cabecalho = normalizada[0] ?? [];
    return [cabecalho, Array(colunas).fill("---"), ...normalizada.slice(1)]
      .map((linha) => `| ${linha.join(" | ")} |`)
      .join("\n");
  }
  if (node.type === "table_row" || node.type === "table_cell" || node.type === "table_header") {
    return blocosFilhos(" ");
  }
  if (node.type === "html" || node.type === "raw_html") {
    avisos.push({ path, type: node.type, code: "html_sanitized" });
    return escaparInline(textoDoHtml(node.text ?? String(node.attrs?.html ?? "")));
  }
  if (node.type && node.type !== "text" && node.type !== "hard_break") {
    avisos.push({ path, type: node.type, code: "unsupported_rich_text_block" });
  }
  return conteudo.length ? blocosFilhos() : inline(node);
}

export function converterClickUpRichText(valor: unknown): {
  markdown: string;
  warnings: AvisoDeConversaoClickUp[];
} {
  const warnings: AvisoDeConversaoClickUp[] = [];
  const markdown =
    typeof valor === "string"
      ? valor
      : valor && typeof valor === "object"
        ? bloco(valor as RichNode, 0, warnings)
        : "";
  return {
    markdown: normalizarTexto(markdown)
      .replace(/\n{3,}/g, "\n\n")
      .trim(),
    warnings: warnings.sort((a, b) => a.path.localeCompare(b.path) || a.type.localeCompare(b.type)),
  };
}

/** Helper simples para quem só precisa do texto; o detalhado preserva os warnings. */
export function clickUpRichTextParaMarkdown(valor: unknown): string {
  return converterClickUpRichText(valor).markdown;
}
