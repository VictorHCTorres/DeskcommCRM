import { converterClickUpRichText, type AvisoDeConversaoClickUp } from "./markdown";

export interface ClickUpDocV3 {
  id: string;
  name: string;
  visibility: string;
  private: boolean;
  revision: string | null;
  raw: Record<string, unknown>;
}

export interface ClickUpAttachmentManifest {
  id: string;
  page_id: string;
  name: string;
  size_bytes: number | null;
  mime_type: string | null;
  download_url: string | null;
}

export interface ClickUpDocExportado {
  doc: ClickUpDocV3;
  markdown: string;
  attachments: ClickUpAttachmentManifest[];
  warnings: AvisoDeConversaoClickUp[];
}

interface ClienteOpcoes {
  token: string;
  workspaceId: string;
  fetchImpl?: typeof fetch;
  dormir?: (ms: number) => Promise<void>;
  deadlineAt?: number;
}

function registro(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

function lista(valor: unknown): unknown[] {
  return Array.isArray(valor) ? valor : [];
}

function texto(valor: unknown, fallback = ""): string {
  return typeof valor === "string" || typeof valor === "number" ? String(valor) : fallback;
}

function docNormalizado(valor: unknown): ClickUpDocV3 | null {
  const raw = registro(valor);
  const id = texto(raw.id ?? raw.doc_id);
  if (!id) return null;
  const visibility = texto(
    raw.visibility ?? raw.access ?? raw.permission_level,
    "PUBLIC",
  ).toUpperCase();
  const privado = raw.private === true || ["PRIVATE", "RESTRICTED"].includes(visibility);
  return {
    id,
    name: texto(raw.name ?? raw.title, `Doc ${id}`),
    visibility,
    private: privado,
    revision: texto(raw.updated_at ?? raw.date_updated ?? raw.revision) || null,
    raw,
  };
}

function paginasDaResposta(valor: unknown): Record<string, unknown>[] {
  const raw = registro(valor);
  const raiz = lista(raw.pages ?? raw.data ?? valor);
  const resultado: Record<string, unknown>[] = [];
  const visitar = (itens: unknown[]) => {
    for (const item of itens) {
      const pagina = registro(item);
      if (texto(pagina.id ?? pagina.page_id)) resultado.push(pagina);
      visitar(lista(pagina.pages ?? pagina.children ?? pagina.subpages));
    }
  };
  visitar(raiz);
  return resultado;
}

function anexosDaPagina(
  pagina: Record<string, unknown>,
  pageId: string,
): ClickUpAttachmentManifest[] {
  const candidatos = lista(pagina.attachments ?? registro(pagina.content).attachments);
  return candidatos.flatMap((valor) => {
    const anexo = registro(valor);
    const id = texto(anexo.id ?? anexo.attachment_id);
    if (!id) return [];
    return [
      {
        id,
        page_id: pageId,
        name: texto(anexo.name ?? anexo.filename, `anexo-${id}`),
        size_bytes: Number.isFinite(Number(anexo.size ?? anexo.size_bytes))
          ? Number(anexo.size ?? anexo.size_bytes)
          : null,
        mime_type: texto(anexo.mime_type ?? anexo.content_type) || null,
        download_url: texto(anexo.download_url ?? anexo.url) || null,
      },
    ];
  });
}

export class ClickUpDocsV3Client {
  private readonly fetchImpl: typeof fetch;
  private readonly dormir: (ms: number) => Promise<void>;

  constructor(private readonly opcoes: ClienteOpcoes) {
    if (!opcoes.token.trim()) throw new Error("clickup_token_missing");
    this.fetchImpl = opcoes.fetchImpl ?? fetch;
    this.dormir = opcoes.dormir ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private async json(path: string): Promise<unknown> {
    const url = `https://api.clickup.com/api/v3${path}`;
    for (let tentativa = 0; tentativa < 4; tentativa += 1) {
      const timeout = this.opcoes.deadlineAt
        ? Math.min(20_000, this.opcoes.deadlineAt - Date.now())
        : 20_000;
      if (timeout <= 0) throw new Error("clickup_live_deadline");
      const resposta = await this.fetchImpl(url, {
        headers: { Authorization: this.opcoes.token, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeout),
      });
      if (resposta.ok) return resposta.json();
      if ((resposta.status === 429 || resposta.status >= 500) && tentativa < 3) {
        const retryAfter = Number(resposta.headers.get("retry-after") ?? 0);
        const espera = retryAfter > 0 ? Math.min(retryAfter * 1_000, 5_000) : 250 * 2 ** tentativa;
        if (this.opcoes.deadlineAt && Date.now() + espera >= this.opcoes.deadlineAt) {
          throw new Error("clickup_live_deadline");
        }
        await this.dormir(espera);
        continue;
      }
      throw new Error(`clickup_v3_http_${resposta.status}`);
    }
    throw new Error("clickup_v3_retry_exhausted");
  }

  async listarDocs(
    input: {
      cursor?: string | null;
      incluirPrivados?: boolean;
      aoCheckpoint?: (cursor: string | null) => Promise<void> | void;
    } = {},
  ): Promise<ClickUpDocV3[]> {
    const docs: ClickUpDocV3[] = [];
    let cursor = input.cursor ?? null;
    const cursoresVisitados = new Set<string>();
    if (cursor) cursoresVisitados.add(cursor);
    do {
      const params = new URLSearchParams({ deleted: "false", archived: "false", limit: "50" });
      if (cursor) params.set("cursor", cursor);
      const resposta = registro(
        await this.json(
          `/workspaces/${encodeURIComponent(this.opcoes.workspaceId)}/docs?${params.toString()}`,
        ),
      );
      const pagina = lista(resposta.docs ?? resposta.data ?? resposta.results)
        .map(docNormalizado)
        .filter((doc): doc is ClickUpDocV3 => Boolean(doc));
      docs.push(...pagina.filter((doc) => input.incluirPrivados || !doc.private));
      const proximoCursor =
        texto(resposta.next_cursor ?? registro(resposta.meta).next_cursor) || null;
      if (proximoCursor && cursoresVisitados.has(proximoCursor)) {
        throw new Error("clickup_v3_cursor_cycle");
      }
      cursor = proximoCursor;
      if (cursor) cursoresVisitados.add(cursor);
      await input.aoCheckpoint?.(cursor);
    } while (cursor);
    return docs;
  }

  async exportarDoc(doc: ClickUpDocV3): Promise<ClickUpDocExportado> {
    const base = `/workspaces/${encodeURIComponent(this.opcoes.workspaceId)}/docs/${encodeURIComponent(doc.id)}/pages`;
    const estrutura = await this.json(`${base}?max_page_depth=-1&content_format=text%2Fmd`);
    const paginas = paginasDaResposta(estrutura);
    const secoes: string[] = [];
    const attachments: ClickUpAttachmentManifest[] = [];
    const warnings: AvisoDeConversaoClickUp[] = [];
    for (const resumo of paginas) {
      const pageId = texto(resumo.id ?? resumo.page_id);
      const detalhe = registro(
        await this.json(`${base}/${encodeURIComponent(pageId)}?content_format=text%2Fmd`),
      );
      const titulo = texto(
        detalhe.name ?? detalhe.title ?? resumo.name ?? resumo.title,
        `Página ${pageId}`,
      );
      const convertido = converterClickUpRichText(
        detalhe.content ?? detalhe.markdown ?? detalhe.rich_text ?? resumo.content ?? "",
      );
      secoes.push(`# ${titulo}\n\n${convertido.markdown}`.trim());
      warnings.push(
        ...convertido.warnings.map((aviso) => ({ ...aviso, path: `page:${pageId}${aviso.path}` })),
      );
      const anexos = anexosDaPagina(detalhe, pageId);
      attachments.push(...anexos);
      warnings.push(
        ...anexos.map((anexo) => ({
          path: `page:${pageId}.attachment:${anexo.id}`,
          type: anexo.mime_type ?? "attachment",
          code: "attachment_skipped_not_imported" as const,
        })),
      );
    }
    return {
      doc,
      markdown: secoes.join("\n\n").trim(),
      attachments: attachments.sort(
        (a, b) => a.page_id.localeCompare(b.page_id) || a.id.localeCompare(b.id),
      ),
      warnings: warnings.sort((a, b) => a.path.localeCompare(b.path)),
    };
  }

  async listarPaginas(docId: string): Promise<string[]> {
    const base = `/workspaces/${encodeURIComponent(this.opcoes.workspaceId)}/docs/${encodeURIComponent(docId)}/pages`;
    const estrutura = await this.json(`${base}?max_page_depth=-1&content_format=text%2Fmd`);
    return [
      ...new Set(
        paginasDaResposta(estrutura)
          .map((page) => texto(page.id ?? page.page_id))
          .filter(Boolean),
      ),
    ].sort();
  }
}

export function docEhPrivado(doc: Pick<ClickUpDocV3, "private" | "visibility">): boolean {
  return doc.private || ["PRIVATE", "RESTRICTED"].includes(doc.visibility.toUpperCase());
}
