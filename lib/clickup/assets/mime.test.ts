import { describe, expect, it } from "vitest";

import { sniffClickUpAssetMime } from "./mime";

describe("MIME real de assets ClickUp", () => {
  it("prefere assinatura ao header/extensão", () => {
    expect(
      sniffClickUpAssetMime(
        new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]),
        "image/png",
        "foto.png",
      ),
    ).toBe("application/pdf");
  });

  it("aceita texto UTF-8 e recusa binário/HTML ativo desconhecido", () => {
    expect(sniffClickUpAssetMime(new TextEncoder().encode("a,b\n1,2"), "text/csv", "x.csv")).toBe(
      "text/csv",
    );
    expect(sniffClickUpAssetMime(new Uint8Array([0, 1, 2]), "text/plain", "x.txt")).toBeNull();
    expect(
      sniffClickUpAssetMime(
        new TextEncoder().encode("<script>x()</script>"),
        "text/html",
        "x.html",
      ),
    ).toBeNull();
  });
});
