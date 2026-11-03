"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";

interface AssetImportado {
  id: string;
  file_name: string;
  file_size: number;
  mime_type: string;
  media_href: string;
}

export function AssetsImportados({ taskId }: { taskId: string }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [files, setFiles] = useState<AssetImportado[] | null>(null);

  async function alternar() {
    const proximo = !aberto;
    setAberto(proximo);
    if (!proximo || files) return;
    setCarregando(true);
    setErro(null);
    try {
      const response = await fetch(`/api/v1/tasks/${taskId}/attachments`);
      const body = (await response.json()) as { data?: { files?: AssetImportado[] } };
      if (!response.ok) throw new Error("assets_fetch_failed");
      setFiles(body.data?.files ?? []);
    } catch {
      setErro(t("Não foi possível carregar os anexos."));
    } finally {
      setCarregando(false);
    }
  }

  return (
    <div className="mt-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 px-2 text-[11px]"
        aria-expanded={aberto}
        onClick={() => void alternar()}
      >
        {t("Anexos do ClickUp")}
      </Button>
      {aberto ? (
        <div className="mt-2 rounded-md border bg-muted/20 p-2" aria-live="polite">
          <p className="text-[11px] text-muted-foreground">
            {t("Arquivos importados — somente leitura.")}
          </p>
          {carregando ? <p className="text-xs text-muted-foreground">{t("Carregando…")}</p> : null}
          {erro ? (
            <p role="alert" className="text-xs text-destructive">
              {erro}
            </p>
          ) : null}
          {files?.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("Nenhum anexo importado.")}</p>
          ) : null}
          {files?.length ? (
            <ul className="mt-2 space-y-1">
              {files.map((file) => (
                <li key={file.id} className="flex items-center justify-between gap-3 text-xs">
                  <a
                    className="min-w-0 truncate underline-offset-2 hover:underline focus-visible:underline"
                    href={file.media_href}
                  >
                    {file.file_name}
                  </a>
                  <span className="shrink-0 text-muted-foreground">
                    {new Intl.NumberFormat(undefined, {
                      style: "unit",
                      unit: "byte",
                      unitDisplay: "narrow",
                    }).format(file.file_size)}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
