import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";

const MAX_ANEXO_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const HOSTS_CLICKUP_PERMITIDOS = [
  "clickup.com",
  "clickupusercontent.com",
  "clickupcdn.com",
] as const;

function ipv4Privado(ip: string): boolean {
  const partes = ip.split(".").map(Number);
  if (partes.length !== 4 || partes.some((parte) => !Number.isInteger(parte))) return true;
  const [a, b] = partes as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function ipv6Privado(ip: string): boolean {
  const normalizado = ip.toLowerCase().split("%")[0] ?? "";
  if (normalizado.startsWith("::ffff:")) {
    const cauda = normalizado.slice("::ffff:".length);
    if (cauda.includes(".")) return ipv4Privado(cauda);
    const hextetos = cauda.split(":");
    if (hextetos.length === 2 && hextetos.every((parte) => /^[0-9a-f]{1,4}$/.test(parte))) {
      const alto = Number.parseInt(hextetos[0]!, 16);
      const baixo = Number.parseInt(hextetos[1]!, 16);
      return ipv4Privado(`${alto >> 8}.${alto & 255}.${baixo >> 8}.${baixo & 255}`);
    }
    return true;
  }
  return (
    normalizado === "::" ||
    normalizado === "::1" ||
    normalizado.startsWith("fc") ||
    normalizado.startsWith("fd") ||
    /^fe[89ab]/.test(normalizado)
  );
}

export function enderecoPrivado(ip: string): boolean {
  const familia = isIP(ip);
  if (familia === 4) return ipv4Privado(ip);
  if (familia === 6) return ipv6Privado(ip);
  return true;
}

type ResolverDns = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

async function resolverPadrao(hostname: string) {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

export async function validarUrlPublica(
  valor: string,
  resolver: ResolverDns = resolverPadrao,
  hostsPermitidos: readonly string[] = HOSTS_CLICKUP_PERMITIDOS,
): Promise<URL> {
  return (await resolverUrlPublica(valor, resolver, hostsPermitidos)).url;
}

async function resolverUrlPublica(
  valor: string,
  resolver: ResolverDns,
  hostsPermitidos: readonly string[],
): Promise<{ url: URL; addresses: string[] }> {
  const url = new URL(valor);
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("attachment_url_not_public_https");
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostsPermitidos.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    throw new Error("attachment_host_refused");
  }
  if (isIP(url.hostname) && enderecoPrivado(url.hostname)) {
    throw new Error("attachment_private_ip");
  }
  const enderecos = await resolver(url.hostname);
  if (enderecos.length === 0 || enderecos.some(({ address }) => enderecoPrivado(address))) {
    throw new Error("attachment_private_dns");
  }
  return { url, addresses: enderecos.map(({ address }) => address) };
}

/** O socket usa o IP já validado; Host e SNI preservam a identidade TLS. */
async function fetchComIpFixado(url: URL, address: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const requisicao = httpsRequest(
      {
        hostname: address,
        servername: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Host: url.host,
          Accept: "application/pdf,text/plain,text/markdown,text/csv;q=0.9",
        },
        timeout: 20_000,
      },
      (resposta) => {
        const headers = new Headers();
        for (const [nome, valor] of Object.entries(resposta.headers)) {
          if (Array.isArray(valor)) valor.forEach((item) => headers.append(nome, item));
          else if (valor !== undefined) headers.set(nome, String(valor));
        }
        resolve(
          new Response(Readable.toWeb(resposta) as ReadableStream, {
            status: resposta.statusCode ?? 500,
            statusText: resposta.statusMessage,
            headers,
          }),
        );
      },
    );
    requisicao.once("timeout", () => requisicao.destroy(new Error("attachment_timeout")));
    requisicao.once("error", reject);
    requisicao.end();
  });
}

function farejarMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 5 && Buffer.from(bytes.subarray(0, 5)).toString("ascii") === "%PDF-") {
    return "application/pdf";
  }
  if (
    bytes.length >= 8 &&
    Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from("89504e470d0a1a0a", "hex"))
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  const amostra = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 8_192)));
  if (!amostra.includes(0) && amostra.toString("utf8").includes("�") === false) return "text/plain";
  return null;
}

const MIME_PERMITIDO = new Set(["application/pdf", "text/plain", "text/markdown", "text/csv"]);

export interface AnexoBaixado {
  bytes: Buffer;
  mime: string;
  urlFinal: string;
}

export async function baixarAnexoSeguro(
  valor: string,
  opcoes: {
    fetchImpl?: typeof fetch;
    resolver?: ResolverDns;
    maxBytes?: number;
    hostsPermitidos?: readonly string[];
    fetchPinnedImpl?: (url: URL, address: string) => Promise<Response>;
  } = {},
): Promise<AnexoBaixado> {
  const fetchImpl = opcoes.fetchImpl;
  const maxBytes = Math.min(opcoes.maxBytes ?? MAX_ANEXO_BYTES, MAX_ANEXO_BYTES);
  const resolver = opcoes.resolver ?? resolverPadrao;
  const hostsPermitidos = opcoes.hostsPermitidos ?? HOSTS_CLICKUP_PERMITIDOS;
  let resolvida = await resolverUrlPublica(valor, resolver, hostsPermitidos);
  let url = resolvida.url;

  for (let redirecionamentos = 0; redirecionamentos <= MAX_REDIRECTS; redirecionamentos += 1) {
    const resposta = fetchImpl
      ? await fetchImpl(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(20_000),
          headers: { Accept: "application/pdf,text/plain,text/markdown,text/csv;q=0.9" },
        })
      : await (opcoes.fetchPinnedImpl ?? fetchComIpFixado)(url, resolvida.addresses[0]!);
    if (resposta.status >= 300 && resposta.status < 400) {
      const destino = resposta.headers.get("location");
      if (!destino || redirecionamentos === MAX_REDIRECTS)
        throw new Error("attachment_redirect_refused");
      resolvida = await resolverUrlPublica(
        new URL(destino, url).toString(),
        resolver,
        hostsPermitidos,
      );
      url = resolvida.url;
      continue;
    }
    if (!resposta.ok || !resposta.body) throw new Error(`attachment_download_${resposta.status}`);
    const declarado = Number(resposta.headers.get("content-length") ?? 0);
    if (declarado > maxBytes) throw new Error("attachment_too_large");
    const leitor = resposta.body.getReader();
    const partes: Uint8Array[] = [];
    let tamanho = 0;
    while (true) {
      const { done, value } = await leitor.read();
      if (done) break;
      tamanho += value.byteLength;
      if (tamanho > maxBytes) {
        await leitor.cancel();
        throw new Error("attachment_too_large");
      }
      partes.push(value);
    }
    const bytes = Buffer.concat(partes.map((parte) => Buffer.from(parte)));
    const farejado = farejarMime(bytes);
    const header = resposta.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const mime =
      farejado === "text/plain" && header && MIME_PERMITIDO.has(header) ? header : farejado;
    if (!mime || !MIME_PERMITIDO.has(mime)) throw new Error("attachment_mime_refused");
    return { bytes, mime, urlFinal: url.toString() };
  }
  throw new Error("attachment_redirect_refused");
}

export const LIMITES_DOS_ANEXOS_CLICKUP = {
  porArquivo: MAX_ANEXO_BYTES,
  porDocumento: 20,
  bytesPorDocumento: 50 * 1024 * 1024,
} as const;
