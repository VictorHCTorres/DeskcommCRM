import { describe, expect, it, vi } from "vitest";

import { baixarAnexoSeguro, enderecoPrivado, validarUrlPublica } from "./anexos-seguros";

const dnsPublico = async () => [{ address: "93.184.216.34", family: 4 }];

describe("anexos ClickUp sem SSRF", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.8",
    "169.254.169.254",
    "192.168.1.2",
    "::1",
    "fd00::1",
    "::ffff:169.254.169.254",
    "::ffff:172.16.0.1",
    "::ffff:a9fe:a9fe",
    "::ffff:ac10:1",
  ])("recusa IP privado %s", (ip) => expect(enderecoPrivado(ip)).toBe(true));

  it("recusa DNS que resolve para rede privada", async () => {
    await expect(
      validarUrlPublica("https://arquivos.clickup.com/a.pdf", async () => [
        { address: "10.0.0.2", family: 4 },
      ]),
    ).rejects.toThrow("attachment_private_dns");
  });

  it("revalida redirect e bloqueia destino privado", async () => {
    const fetchImpl = async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://interno.clickup.com/segredo" },
      });
    await expect(
      baixarAnexoSeguro("https://publico.clickup.com/a.pdf", {
        fetchImpl: fetchImpl as typeof fetch,
        resolver: async (host) => [
          { address: host === "interno.clickup.com" ? "127.0.0.1" : "93.184.216.34", family: 4 },
        ],
      }),
    ).rejects.toThrow("attachment_private_dns");
  });

  it("fareja o MIME e aceita PDF público dentro do limite", async () => {
    const bytes = Buffer.from("%PDF-1.7\nconteudo");
    const fetchImpl = async () =>
      new Response(bytes, {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(bytes.length),
        },
      });
    const anexo = await baixarAnexoSeguro("https://attachments.clickup.com/a.bin", {
      fetchImpl: fetchImpl as typeof fetch,
      resolver: dnsPublico,
    });
    expect(anexo.mime).toBe("application/pdf");
    expect(anexo.bytes).toEqual(bytes);
  });

  it("recusa host público fora da allowlist do ClickUp antes do fetch", async () => {
    await expect(
      baixarAnexoSeguro("https://example.com/a.pdf", { resolver: dnsPublico }),
    ).rejects.toThrow("attachment_host_refused");
  });

  it("pina a conexão no IP público que acabou de validar", async () => {
    const bytes = Buffer.from("texto seguro");
    const fetchPinnedImpl = vi.fn(async (_url: URL, _address: string) =>
      Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: { "content-type": "text/plain", "content-length": String(bytes.length) },
        }),
      ),
    );
    await baixarAnexoSeguro("https://attachments.clickup.com/a.txt", {
      resolver: dnsPublico,
      fetchPinnedImpl,
    });
    expect(fetchPinnedImpl).toHaveBeenCalledWith(expect.any(URL), "93.184.216.34");
  });
});
