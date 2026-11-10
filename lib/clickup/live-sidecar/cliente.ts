import { ClienteDeComentariosClickUp } from "@/lib/clickup/comments/cliente";

const API_V3 = "https://api.clickup.com/api/v3";
type Registro = Record<string, unknown>;
const registro = (value: unknown): Registro =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Registro) : {};
const lista = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const texto = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : "";

export interface ClickUpRemoteAsset {
  attachmentId: string;
  fileName: string;
  declaredSize: number | null;
  sourceRevision: string | null;
  /** Transitório e somente em memória. Nunca persista ou registre. */
  sourceUrl: string | null;
}

export class ClienteLiveSidecarClickUp {
  readonly comments: ClienteDeComentariosClickUp;

  constructor(
    private readonly input: {
      token: string;
      fetchImpl?: typeof fetch;
      dormir?: (ms: number) => Promise<void>;
      deadlineAt?: number;
    },
  ) {
    if (!input.token.trim()) throw new Error("clickup_token_missing");
    this.comments = new ClienteDeComentariosClickUp(input);
  }

  private async json(path: string): Promise<unknown> {
    const fetchImpl = this.input.fetchImpl ?? fetch;
    const dormir = this.input.dormir ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const timeout = this.input.deadlineAt
        ? Math.min(20_000, this.input.deadlineAt - Date.now())
        : 20_000;
      if (timeout <= 0) throw new Error("clickup_live_deadline");
      const response = await fetchImpl(`${API_V3}${path}`, {
        headers: { Authorization: this.input.token, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      if (response.ok) return response.json();
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        const retryAfter = Math.min(
          5,
          Math.max(0, Number(response.headers.get("retry-after") ?? 0)),
        );
        const espera = retryAfter > 0 ? retryAfter * 1_000 : Math.min(5_000, 250 * 2 ** attempt);
        if (this.input.deadlineAt && Date.now() + espera >= this.input.deadlineAt) {
          throw new Error("clickup_live_deadline");
        }
        await dormir(espera);
        continue;
      }
      throw new Error(`clickup_assets_http_${response.status}`);
    }
    throw new Error("clickup_assets_retry_exhausted");
  }

  async listarAssetsDaTask(workspaceId: string, taskId: string): Promise<ClickUpRemoteAsset[]> {
    const result: ClickUpRemoteAsset[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: "100" });
      if (cursor) params.set("cursor", cursor);
      const body = registro(
        await this.json(
          `/workspaces/${encodeURIComponent(workspaceId)}/attachments/${encodeURIComponent(taskId)}/attachments?${params}`,
        ),
      );
      for (const value of lista(body.attachments ?? body.data ?? body.items)) {
        const raw = registro(value);
        const attachmentId = texto(raw.id ?? raw.attachment_id);
        if (!attachmentId) continue;
        const size = Number(raw.size ?? raw.size_bytes);
        result.push({
          attachmentId,
          fileName:
            texto(raw.file_name ?? raw.filename ?? raw.name) || `attachment-${attachmentId}`,
          declaredSize: Number.isFinite(size) && size >= 0 ? size : null,
          sourceRevision: texto(raw.updated_at ?? raw.date_updated ?? raw.created_at) || null,
          sourceUrl: texto(raw.download_url ?? raw.url ?? raw.source_url) || null,
        });
      }
      const next = texto(body.next_cursor ?? registro(body.meta).next_cursor) || null;
      if (next && cursors.has(next)) throw new Error("clickup_assets_cursor_cycle");
      if (next) cursors.add(next);
      cursor = next;
    } while (cursor);
    return result;
  }

  async listarAssetsDaPagina(
    workspaceId: string,
    docId: string,
    pageId: string,
  ): Promise<ClickUpRemoteAsset[]> {
    const body = registro(
      await this.json(
        `/workspaces/${encodeURIComponent(workspaceId)}/docs/${encodeURIComponent(docId)}/pages/${encodeURIComponent(pageId)}?content_format=text%2Fmd`,
      ),
    );
    return lista(body.attachments ?? registro(body.content).attachments).flatMap((value) => {
      const raw = registro(value);
      const attachmentId = texto(raw.id ?? raw.attachment_id);
      if (!attachmentId) return [];
      const size = Number(raw.size ?? raw.size_bytes);
      return [
        {
          attachmentId,
          fileName:
            texto(raw.file_name ?? raw.filename ?? raw.name) || `attachment-${attachmentId}`,
          declaredSize: Number.isFinite(size) && size >= 0 ? size : null,
          sourceRevision: texto(raw.updated_at ?? raw.date_updated ?? raw.created_at) || null,
          sourceUrl: texto(raw.download_url ?? raw.url ?? raw.source_url) || null,
        },
      ];
    });
  }
}
