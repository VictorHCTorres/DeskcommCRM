import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FormularioPublicoClient } from "./_client";

afterEach(() => vi.unstubAllGlobals());

describe("FormularioPublicoClient", () => {
  it("envia as perguntas ao endpoint canônico e confirma sem redirecionar", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ data: { lead_id: "lead-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <FormularioPublicoClient
        nome="Diagnóstico comercial"
        token="token-publico-123"
        campos={[{ key: "empresa", label: "Empresa", type: "text", required: true }]}
      />,
    );

    expect(screen.getByLabelText(/^Nome/)).toBeRequired();
    expect(document.querySelector('label[for="nome"]')).toHaveTextContent("Nome *");
    expect(document.querySelector('label[for="telefone"]')).toHaveTextContent("WhatsApp *");
    expect(document.querySelector('label[for="campo-empresa"]')).toHaveTextContent("Empresa *");

    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText(/^WhatsApp/), { target: { value: "11999999999" } });
    fireEvent.change(screen.getByLabelText(/^Empresa/), { target: { value: "Acme" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar dados" }));

    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Dados enviados"));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/webhooks/in/token-publico-123",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"empresa":"Acme"'),
      }),
    );
  });

  it("mantém o formulário e anuncia a falha para tecnologia assistiva", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { message: "detalhe interno que não pode chegar à pessoa" },
            }),
            { status: 422, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    render(<FormularioPublicoClient nome="Contato" token="token-publico-123" campos={[]} />);
    fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: "Ana" } });
    fireEvent.change(screen.getByLabelText(/^WhatsApp/), { target: { value: "11999999999" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar dados" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Não foi possível enviar agora. Confira os dados e tente novamente.",
      ),
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("detalhe interno");
    expect(screen.getByRole("button", { name: "Enviar dados" })).toBeEnabled();
  });

  it("conserva external_id no retry e o renova depois do sucesso", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { lead_id: "lead-1" } }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { lead_id: "lead-2" } }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<FormularioPublicoClient nome="Contato" token="token-publico-123" campos={[]} />);
    const preencher = () => {
      fireEvent.change(screen.getByLabelText(/^Nome/), { target: { value: "Ana" } });
      fireEvent.change(screen.getByLabelText(/^WhatsApp/), { target: { value: "11999999999" } });
    };

    preencher();
    fireEvent.click(screen.getByRole("button", { name: "Enviar dados" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Enviar dados" }));
    await screen.findByRole("status");

    const primeiro = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      external_id: string;
    };
    const retry = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { external_id: string };
    expect(retry.external_id).toBe(primeiro.external_id);

    fireEvent.click(screen.getByRole("button", { name: "Enviar outra resposta" }));
    preencher();
    fireEvent.click(screen.getByRole("button", { name: "Enviar dados" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const novaResposta = JSON.parse(String(fetchMock.mock.calls[2]?.[1]?.body)) as {
      external_id: string;
    };
    expect(novaResposta.external_id).not.toBe(primeiro.external_id);
  });
});
