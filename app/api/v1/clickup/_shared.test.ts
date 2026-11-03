import { afterEach, describe, expect, it, vi } from "vitest";

import { clickupFailure } from "./_shared";

describe("erros públicos do importador ClickUp", () => {
  afterEach(() => vi.restoreAllMocks());

  it("não devolve mensagem SQL, nome de coluna nem segredo", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = clickupFailure(
      new Error('relation "clickup_connections" failed at token_ciphertext=segredo'),
      "req-w3",
    );
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error.message).toBe("Não foi possível concluir a operação do ClickUp.");
    expect(JSON.stringify(body)).not.toContain("token_ciphertext");
    expect(JSON.stringify(body)).not.toContain("segredo");
  });
});
