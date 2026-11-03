import { describe, expect, it } from "vitest";

import { clickUpRichTextParaMarkdown, converterClickUpRichText } from "./markdown";

describe("rich text do ClickUp para Markdown", () => {
  it("é determinístico e normaliza texto Markdown já fornecido", () => {
    expect(clickUpRichTextParaMarkdown("# Título  \r\n\r\n\r\nTexto   \r\n")).toBe(
      "# Título\n\nTexto",
    );
  });

  it("preserva hierarquia, listas, links e marcas numa saída estável", () => {
    const rich = {
      type: "doc",
      content: [
        { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Política" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Leia ", marks: [{ type: "bold" }] },
            {
              type: "text",
              text: "a fonte",
              marks: [{ type: "link", attrs: { href: "https://example.com/base" } }],
            },
          ],
        },
        {
          type: "bullet_list",
          content: [
            {
              type: "list_item",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Um" }] }],
            },
            {
              type: "list_item",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Dois" }] }],
            },
          ],
        },
      ],
    };
    expect(clickUpRichTextParaMarkdown(rich)).toBe(
      "## Política\n\n**Leia **[a fonte](https://example.com/base)\n\n- Um\n- Dois",
    );
  });

  it("converte tabela, sanitiza HTML e avisa o path de bloco não suportado", () => {
    const resultado = converterClickUpRichText({
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "table_row",
              content: [{ type: "table_header", content: [{ type: "text", text: "Campo" }] }],
            },
            {
              type: "table_row",
              content: [{ type: "table_cell", content: [{ type: "text", text: "Valor" }] }],
            },
          ],
        },
        { type: "raw_html", text: "<script>alert(1)</script><p>Texto <b>seguro</b></p>" },
        {
          type: "whiteboard_embed",
          content: [{ type: "paragraph", content: [{ type: "text", text: "Resumo" }] }],
        },
      ],
    });
    expect(resultado.markdown).toContain("| Campo |\n| --- |\n| Valor |");
    expect(resultado.markdown).toContain("Texto seguro");
    expect(resultado.markdown).not.toContain("script");
    expect(resultado.warnings).toEqual([
      { path: "$.content[1]", type: "raw_html", code: "html_sanitized" },
      {
        path: "$.content[2]",
        type: "whiteboard_embed",
        code: "unsupported_rich_text_block",
      },
    ]);
  });
});
