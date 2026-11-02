import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import {
  buscarFormularioPublico,
  CAMPO_ANTISPAM_FORMULARIO_PUBLICO,
  ehSubmissaoFormularioPublico,
  filtrarHoneypotFormularioPublico,
  submissaoFormularioPublicoEhValida,
} from "@/lib/webhooks/formulario-publico";

function bancoCom(linha: Record<string, unknown> | null, error: unknown = null): SupabaseClient {
  const cadeia = {
    select: vi.fn(),
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data: linha, error })),
  };
  cadeia.select.mockReturnValue(cadeia);
  cadeia.eq.mockReturnValue(cadeia);
  return { from: vi.fn(() => cadeia) } as unknown as SupabaseClient;
}

describe("formulário público nativo", () => {
  it("expõe só nome, token e perguntas de fonte ativa sem HMAC", async () => {
    const formulario = await buscarFormularioPublico(
      "token-publico-123",
      bancoCom({
        name: "Diagnóstico comercial",
        path_token: "token-publico-123",
        form_fields: [{ key: "empresa", label: "Empresa", type: "text", required: true }],
        is_active: true,
        secret_encrypted: null,
      }),
    );

    expect(formulario).toEqual({
      nome: "Diagnóstico comercial",
      token: "token-publico-123",
      campos: [{ key: "empresa", label: "Empresa", type: "text", required: true }],
    });
    expect(formulario).not.toHaveProperty("organization_id");
  });

  it.each([
    ["pausada", { is_active: false, secret_encrypted: null }],
    ["com HMAC", { is_active: true, secret_encrypted: "\\x1234" }],
  ])("não publica fonte %s", async (_caso, estado) => {
    await expect(
      buscarFormularioPublico(
        "token-publico-123",
        bancoCom({ name: "Fonte", path_token: "token-publico-123", form_fields: [], ...estado }),
      ),
    ).resolves.toBeNull();
  });

  it("remove a chave reservada e bloqueia bot que preenche o honeypot", () => {
    expect(
      filtrarHoneypotFormularioPublico({
        nome: "Robô",
        [CAMPO_ANTISPAM_FORMULARIO_PUBLICO]: "https://spam.test",
      }),
    ).toEqual({ bloqueado: true, payload: { nome: "Robô" } });

    expect(
      filtrarHoneypotFormularioPublico({
        nome: "Pessoa",
        [CAMPO_ANTISPAM_FORMULARIO_PUBLICO]: "",
      }),
    ).toEqual({ bloqueado: false, payload: { nome: "Pessoa" } });
  });

  it("identifica a submissão nativa pela presença da chave antes da limpeza", () => {
    const payload = {
      nome: "Pessoa",
      [CAMPO_ANTISPAM_FORMULARIO_PUBLICO]: "",
    };

    expect(ehSubmissaoFormularioPublico(payload)).toBe(true);
    expect(ehSubmissaoFormularioPublico(filtrarHoneypotFormularioPublico(payload).payload)).toBe(
      false,
    );
  });

  it("exige nome, telefone e perguntas obrigatórias; checkbox só vale true", () => {
    const campos = [
      { key: "empresa", label: "Empresa", type: "text" as const, required: true },
      { key: "aceite", label: "Aceite", type: "checkbox" as const, required: true },
    ];

    expect(
      submissaoFormularioPublicoEhValida(
        { nome: "Ana", telefone: "11999999999", empresa: "Acme", aceite: "true" },
        campos,
      ),
    ).toBe(true);
    expect(
      submissaoFormularioPublicoEhValida(
        { nome: "Ana", telefone: "11999999999", empresa: "Acme", aceite: "false" },
        campos,
      ),
    ).toBe(false);
    expect(
      submissaoFormularioPublicoEhValida(
        { nome: " ", telefone: "11999999999", empresa: "Acme", aceite: true },
        campos,
      ),
    ).toBe(false);
  });
});
