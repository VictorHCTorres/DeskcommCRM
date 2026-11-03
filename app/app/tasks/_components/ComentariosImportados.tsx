"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";

interface ComentarioImportado {
  id: string;
  source_comment_id: string;
  parent_source_comment_id: string | null;
  author_display_name: string;
  body_markdown: string;
  source_created_at: string;
  source_updated_at: string | null;
}

export function ComentariosImportados({ taskId }: { taskId: string }) {
  const t = useT();
  const tag = useTagDeIdioma();
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [comments, setComments] = useState<ComentarioImportado[] | null>(null);

  async function alternar() {
    const proximo = !aberto;
    setAberto(proximo);
    if (!proximo || comments) return;
    setCarregando(true);
    setErro(null);
    try {
      const response = await fetch(`/api/v1/tasks/${taskId}/comments`);
      const body = (await response.json()) as {
        data?: { comments?: ComentarioImportado[] };
        error?: { message?: string };
      };
      if (!response.ok) throw new Error("comments_fetch_failed");
      setComments(body.data?.comments ?? []);
    } catch {
      setErro(t("Não foi possível carregar os comentários."));
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="mt-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[11px]"
        aria-expanded={aberto}
        onClick={() => void alternar()}
      >
        {t("Comentários do ClickUp")}
      </Button>
      {aberto ? (
        <div className="mt-2 space-y-2 rounded-md border bg-muted/20 p-2" aria-live="polite">
          <p className="text-[11px] text-muted-foreground">
            {t("Histórico importado — somente leitura.")}
          </p>
          {carregando ? <p className="text-xs text-muted-foreground">{t("Carregando…")}</p> : null}
          {erro ? (
            <p role="alert" className="text-xs text-destructive">
              {erro}
            </p>
          ) : null}
          {comments?.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("Nenhum comentário importado.")}</p>
          ) : null}
          {comments?.map((comment) => (
            <article
              key={comment.id}
              className={comment.parent_source_comment_id ? "ml-5 border-l pl-3" : ""}
            >
              <div className="flex flex-wrap items-baseline gap-2 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{comment.author_display_name}</span>
                <time dateTime={comment.source_created_at}>
                  {new Date(comment.source_created_at).toLocaleString(tag)}
                </time>
              </div>
              <p className="mt-1 text-xs break-words whitespace-pre-wrap">
                {comment.body_markdown}
              </p>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
