import { describe, expect, it } from "vitest";

import type { ClickUpManifest } from "@/lib/clickup/contrato";

import { estadoDaPrivacidadeDosDocs } from "./privacidade";

function manifesto(metadata: Record<string, unknown>): ClickUpManifest {
  return {
    connection_id: "00000000-0000-4000-8000-000000000001",
    workspace_id: "wk",
    source: "bundle",
    scope: "docs",
    manifest_version: 3,
    objects: [
      {
        source_type: "doc",
        source_id: "d1",
        metadata,
        content_access: "full",
        payload: { format: "markdown", content: "texto" },
      },
    ],
  };
}

describe("privacidade dos Docs importados", () => {
  it("exige confirmação org-wide em todos os privados", () => {
    expect(estadoDaPrivacidadeDosDocs(manifesto({ visibility: "PRIVATE" }))).toEqual({
      temPrivado: true,
      inclusaoExplicita: false,
    });
    expect(
      estadoDaPrivacidadeDosDocs(
        manifesto({ visibility: "PRIVATE", private_scope_explicit: true }),
      ),
    ).toEqual({ temPrivado: true, inclusaoExplicita: true });
  });

  it("não cria gate adicional para Docs públicos", () => {
    expect(estadoDaPrivacidadeDosDocs(manifesto({ visibility: "PUBLIC" }))).toEqual({
      temPrivado: false,
      inclusaoExplicita: false,
    });
  });
});
