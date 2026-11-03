import { createHash } from "node:crypto";

export interface ComentarioClickUpNormalizado {
  comment_id: string;
  task_id: string;
  parent_comment_id: string | null;
  source_created_at: string;
  source_updated_at: string | null;
  author: { source_user_id: string; display_name: string };
  body_markdown: string;
  attachment_ids: string[];
}

type Registro = Record<string, unknown>;

const registro = (valor: unknown): Registro =>
  valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as Registro) : {};
const lista = (valor: unknown): unknown[] => (Array.isArray(valor) ? valor : []);
const texto = (valor: unknown): string =>
  typeof valor === "string" || typeof valor === "number" ? String(valor) : "";

function removerHtmlAtivo(valor: string): string {
  return valor
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&amp;/gi, "&");
}

/** Markdown seguro para render read-only: sem HTML, imagens ou schemes ativos. */
export function sanitizarComentarioMarkdown(valor: string): string {
  return removerHtmlAtivo(valor)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(\s*(?:javascript|data|vbscript):[^)]*\)/gi, "$1")
    .replace(/@/g, "＠")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((linha) => linha.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function corpoDoComentario(raw: Registro): string {
  const markdown = texto(raw.body_markdown ?? raw.markdown ?? raw.comment_text);
  if (markdown) return sanitizarComentarioMarkdown(markdown);
  const segmentos = lista(raw.comment).map((valor) => {
    const segmento = registro(valor);
    const conteudo = texto(segmento.text ?? segmento.value);
    return sanitizarComentarioMarkdown(conteudo);
  });
  return sanitizarComentarioMarkdown(segmentos.join(""));
}

function dataIso(valor: unknown): string {
  const bruta = texto(valor);
  if (!bruta) throw new Error("clickup_comment_missing_date");
  const numero = Number(bruta);
  const data = Number.isFinite(numero) ? new Date(numero) : new Date(bruta);
  if (Number.isNaN(data.getTime())) throw new Error("clickup_comment_invalid_date");
  return data.toISOString();
}

function autorSeguro(raw: Registro): ComentarioClickUpNormalizado["author"] {
  const user = registro(raw.user ?? raw.author);
  const sourceUserId = texto(user.id ?? user.userid ?? raw.user_id);
  const nome = texto(user.username ?? user.display_name ?? user.name ?? "Usuário ClickUp")
    .replace(/[\r\n\t]/g, " ")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[e-mail removido]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return { source_user_id: sourceUserId || "unknown", display_name: nome || "Usuário ClickUp" };
}

export function normalizarComentarioClickUp(input: {
  taskId: string;
  raw: unknown;
  parentCommentId?: string | null;
}): ComentarioClickUpNormalizado {
  const raw = registro(input.raw);
  const commentId = texto(raw.id ?? raw.comment_id);
  if (!commentId || !input.taskId) throw new Error("clickup_comment_missing_identity");
  const criado = dataIso(raw.date ?? raw.date_created ?? raw.created_at);
  const atualizacaoBruta = raw.date_updated ?? raw.updated_at;
  const atualizado =
    atualizacaoBruta === undefined || atualizacaoBruta === null ? null : dataIso(atualizacaoBruta);
  return {
    comment_id: commentId,
    task_id: input.taskId,
    parent_comment_id: input.parentCommentId ?? (texto(raw.parent_comment_id) || null),
    source_created_at: criado,
    source_updated_at: atualizado,
    author: autorSeguro(raw),
    body_markdown: corpoDoComentario(raw),
    attachment_ids: [
      ...new Set(
        lista(raw.attachments).flatMap((valor) => {
          const id = texto(registro(valor).id ?? registro(valor).attachment_id);
          return id ? [id] : [];
        }),
      ),
    ].sort(),
  };
}

function canonico(valor: unknown): string {
  if (valor === null || typeof valor !== "object") return JSON.stringify(valor);
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`;
  const objeto = valor as Registro;
  return `{${Object.keys(objeto)
    .sort()
    .map((chave) => `${JSON.stringify(chave)}:${canonico(objeto[chave])}`)
    .join(",")}}`;
}

export function hashDoComentario(comentario: ComentarioClickUpNormalizado): string {
  return createHash("sha256").update(canonico(comentario)).digest("hex");
}

export function ordenarComentariosComReplies(
  comentarios: ComentarioClickUpNormalizado[],
): ComentarioClickUpNormalizado[] {
  const porPai = new Map<string | null, ComentarioClickUpNormalizado[]>();
  for (const comentario of comentarios) {
    const grupo = porPai.get(comentario.parent_comment_id) ?? [];
    grupo.push(comentario);
    porPai.set(comentario.parent_comment_id, grupo);
  }
  const ordenar = (itens: ComentarioClickUpNormalizado[]) =>
    itens.sort(
      (a, b) =>
        a.source_created_at.localeCompare(b.source_created_at) ||
        a.comment_id.localeCompare(b.comment_id),
    );
  const saida: ComentarioClickUpNormalizado[] = [];
  const visitar = (comentario: ComentarioClickUpNormalizado) => {
    saida.push(comentario);
    for (const reply of ordenar(porPai.get(comentario.comment_id) ?? [])) visitar(reply);
  };
  for (const raiz of ordenar(porPai.get(null) ?? [])) visitar(raiz);
  return saida;
}
