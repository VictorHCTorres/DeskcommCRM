import {
  normalizarComentarioClickUp,
  ordenarComentariosComReplies,
  type ComentarioClickUpNormalizado,
} from "./normalizar";

const API_V2 = "https://api.clickup.com/api/v2";
const TAMANHO_PAGINA = 25;

type Registro = Record<string, unknown>;
const registro = (valor: unknown): Registro =>
  valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Registro) : {};
const lista = (valor: unknown): unknown[] => (Array.isArray(valor) ? valor : []);
const texto = (valor: unknown): string =>
  typeof valor === "string" || typeof valor === "number" ? String(valor) : "";

export interface ResultadoDosComentariosClickUp {
  comments: ComentarioClickUpNormalizado[];
  topLevelCount: number;
  repliesCount: number;
  terminalCursor: { start: string; start_id: string } | null;
}

export class ClienteDeComentariosClickUp {
  constructor(
    private readonly input: {
      token: string;
      fetchImpl?: typeof fetch;
      dormir?: (ms: number) => Promise<void>;
      deadlineAt?: number;
    },
  ) {
    if (!input.token.trim()) throw new Error("clickup_token_missing");
  }

  private async json(path: string): Promise<unknown> {
    const fetchImpl = this.input.fetchImpl ?? fetch;
    const dormir = this.input.dormir ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    for (let tentativa = 0; tentativa < 4; tentativa += 1) {
      const timeout = this.input.deadlineAt
        ? Math.min(20_000, this.input.deadlineAt - Date.now())
        : 20_000;
      if (timeout <= 0) throw new Error("clickup_live_deadline");
      const resposta = await fetchImpl(`${API_V2}${path}`, {
        headers: { Authorization: this.input.token, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      if (resposta.ok) return resposta.json();
      if ((resposta.status === 429 || resposta.status >= 500) && tentativa < 3) {
        const retryAfter = Number(resposta.headers.get("retry-after") ?? 0);
        const espera = retryAfter > 0 ? Math.min(retryAfter * 1_000, 5_000) : 250 * 2 ** tentativa;
        if (this.input.deadlineAt && Date.now() + espera >= this.input.deadlineAt) {
          throw new Error("clickup_live_deadline");
        }
        await dormir(espera);
        continue;
      }
      throw new Error(`clickup_comments_http_${resposta.status}`);
    }
    throw new Error("clickup_comments_retry_exhausted");
  }

  async listarDaTask(taskId: string): Promise<ResultadoDosComentariosClickUp> {
    if (!taskId) throw new Error("clickup_task_id_missing");
    const brutos: Registro[] = [];
    const cursores = new Set<string>();
    let cursor: { start: string; start_id: string } | null = null;
    while (true) {
      const params = new URLSearchParams();
      if (cursor) {
        params.set("start", cursor.start);
        params.set("start_id", cursor.start_id);
      }
      const resposta = registro(
        await this.json(
          `/task/${encodeURIComponent(taskId)}/comment${params.size ? `?${params}` : ""}`,
        ),
      );
      const pagina = lista(resposta.comments).map(registro);
      brutos.push(...pagina);
      if (pagina.length < TAMANHO_PAGINA) break;
      const ultimo = pagina.at(-1) ?? {};
      const proximo = {
        start: texto(ultimo.date ?? ultimo.date_created),
        start_id: texto(ultimo.id ?? ultimo.comment_id),
      };
      if (!proximo.start || !proximo.start_id) throw new Error("clickup_comments_cursor_missing");
      const chave = `${proximo.start}\0${proximo.start_id}`;
      if (cursores.has(chave)) throw new Error("clickup_comments_cursor_cycle");
      cursores.add(chave);
      cursor = proximo;
    }

    const comments = brutos.map((raw) => normalizarComentarioClickUp({ taskId, raw }));
    let repliesCount = 0;
    for (const bruto of brutos) {
      const replyCount = Number(bruto.reply_count ?? bruto.replies_count ?? 0);
      if (!Number.isFinite(replyCount) || replyCount <= 0) continue;
      const parentId = texto(bruto.id ?? bruto.comment_id);
      const resposta = registro(await this.json(`/comment/${encodeURIComponent(parentId)}/reply`));
      const replies = lista(resposta.comments ?? resposta.replies);
      if (replies.length !== replyCount) throw new Error("clickup_replies_incomplete");
      repliesCount += replies.length;
      comments.push(
        ...replies.map((raw) =>
          normalizarComentarioClickUp({ taskId, raw, parentCommentId: parentId }),
        ),
      );
    }
    return {
      comments: ordenarComentariosComReplies(comments),
      topLevelCount: brutos.length,
      repliesCount,
      terminalCursor: cursor,
    };
  }
}
