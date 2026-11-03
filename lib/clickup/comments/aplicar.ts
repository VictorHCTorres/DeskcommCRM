import { createHash } from "node:crypto";

import {
  hashDoComentario,
  ordenarComentariosComReplies,
  type ComentarioClickUpNormalizado,
} from "./normalizar";

export type DestinoDaTaskClickUp =
  | { kind: "lead"; organizationId: string; targetId: string }
  | { kind: "task"; organizationId: string; targetId: string };

export interface MappingDeComentarioClickUp {
  sourceHash: string;
  destinationId: string;
  targetKind: "lead" | "task";
  targetId: string;
}

export interface PortaDeComentariosClickUp {
  resolverDestino(taskId: string): Promise<DestinoDaTaskClickUp | null>;
  encontrarMapping(commentId: string): Promise<MappingDeComentarioClickUp | null>;
  gravarAtividadeHistorica(input: {
    id: string;
    organizationId: string;
    leadId: string;
    type: "clickup_comment_imported";
    actorKind: "system";
    performedAt: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
  gravarComentarioDeTask(input: {
    id: string;
    organizationId: string;
    taskId: string;
    sourceCommentId: string;
    sourceHash: string;
    parentSourceCommentId: string | null;
    bodyMarkdown: string;
    author: ComentarioClickUpNormalizado["author"];
    sourceCreatedAt: string;
    sourceUpdatedAt: string | null;
    readOnly: true;
  }): Promise<void>;
  registrarMapping(input: {
    commentId: string;
    sourceHash: string;
    destinationId: string;
    targetKind: "lead" | "task";
    targetId: string;
  }): Promise<void>;
}

export type ResultadoDeComentario =
  | { commentId: string; outcome: "succeeded" | "unchanged" }
  | { commentId: string; outcome: "blocked"; reason: "blocked_parent_not_mapped" }
  | { commentId: string; outcome: "conflict"; reason: "clickup_comment_create_only_conflict" };

export function idDeterministicoDoComentario(
  organizationId: string,
  workspaceId: string,
  commentId: string,
): string {
  const hex = createHash("sha256")
    .update(`clickup-comment\0${organizationId}\0${workspaceId}\0${commentId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Aplica pais antes de replies. A porta de atividade é deliberadamente
 * histórica: sua implementação DB deve usar a RPC sem efeitos colaterais.
 */
export async function aplicarComentariosClickUp(input: {
  workspaceId: string;
  comments: ComentarioClickUpNormalizado[];
  porta: PortaDeComentariosClickUp;
}): Promise<ResultadoDeComentario[]> {
  const resultados: ResultadoDeComentario[] = [];
  const mappingsDaRodada = new Map<string, MappingDeComentarioClickUp>();
  for (const comentario of ordenarComentariosComReplies(input.comments)) {
    const sourceHash = hashDoComentario(comentario);
    const existente = await input.porta.encontrarMapping(comentario.comment_id);
    if (existente) {
      resultados.push(
        existente.sourceHash === sourceHash
          ? { commentId: comentario.comment_id, outcome: "unchanged" }
          : {
              commentId: comentario.comment_id,
              outcome: "conflict",
              reason: "clickup_comment_create_only_conflict",
            },
      );
      mappingsDaRodada.set(comentario.comment_id, existente);
      continue;
    }
    const destino = await input.porta.resolverDestino(comentario.task_id);
    if (!destino) {
      resultados.push({
        commentId: comentario.comment_id,
        outcome: "blocked",
        reason: "blocked_parent_not_mapped",
      });
      continue;
    }
    if (comentario.parent_comment_id) {
      const parent =
        mappingsDaRodada.get(comentario.parent_comment_id) ??
        (await input.porta.encontrarMapping(comentario.parent_comment_id));
      if (!parent || parent.targetKind !== destino.kind || parent.targetId !== destino.targetId) {
        resultados.push({
          commentId: comentario.comment_id,
          outcome: "blocked",
          reason: "blocked_parent_not_mapped",
        });
        continue;
      }
    }
    const destinationId = idDeterministicoDoComentario(
      destino.organizationId,
      input.workspaceId,
      comentario.comment_id,
    );
    if (destino.kind === "lead") {
      await input.porta.gravarAtividadeHistorica({
        id: destinationId,
        organizationId: destino.organizationId,
        leadId: destino.targetId,
        type: "clickup_comment_imported",
        actorKind: "system",
        performedAt: comentario.source_created_at,
        payload: {
          clickup_comment_id: comentario.comment_id,
          clickup_parent_comment_id: comentario.parent_comment_id,
          source_hash: sourceHash,
          source_updated_at: comentario.source_updated_at,
          author: comentario.author,
          body_markdown: comentario.body_markdown,
          attachment_ids: comentario.attachment_ids,
          historical_import: true,
        },
      });
    } else {
      await input.porta.gravarComentarioDeTask({
        id: destinationId,
        organizationId: destino.organizationId,
        taskId: destino.targetId,
        sourceCommentId: comentario.comment_id,
        sourceHash,
        parentSourceCommentId: comentario.parent_comment_id,
        bodyMarkdown: comentario.body_markdown,
        author: comentario.author,
        sourceCreatedAt: comentario.source_created_at,
        sourceUpdatedAt: comentario.source_updated_at,
        readOnly: true,
      });
    }
    const mapping = {
      commentId: comentario.comment_id,
      sourceHash,
      destinationId,
      targetKind: destino.kind,
      targetId: destino.targetId,
    };
    await input.porta.registrarMapping(mapping);
    mappingsDaRodada.set(comentario.comment_id, mapping);
    resultados.push({ commentId: comentario.comment_id, outcome: "succeeded" });
  }
  return resultados;
}
