"use client";

import { useState } from "react";
import { Upload } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useClickUpDocsExecute, useClickUpDocsPreview } from "@/hooks/clickup/useClickUpDocsImport";
import { useT } from "@/hooks/i18n/useT";

function registro(valor: unknown): Record<string, unknown> {
  return valor && typeof valor === "object" && !Array.isArray(valor)
    ? (valor as Record<string, unknown>)
    : {};
}

export function ImportarClickUpDocs({ podeImportarPrivados }: { podeImportarPrivados: boolean }) {
  const t = useT();
  const [aberto, setAberto] = useState(false);
  const [manifest, setManifest] = useState<Record<string, unknown> | null>(null);
  const [temPrivados, setTemPrivados] = useState(false);
  const [confirmouPrivados, setConfirmouPrivados] = useState(false);
  const preview = useClickUpDocsPreview();
  const execute = useClickUpDocsExecute();

  async function lerArquivo(file: File | undefined) {
    preview.reset();
    execute.reset();
    if (!file) return setManifest(null);
    const parsed = registro(JSON.parse(await file.text()));
    const objects = Array.isArray(parsed.objects) ? parsed.objects : [];
    const privados = objects.some((objeto) => {
      const metadata = registro(registro(objeto).metadata);
      return (
        metadata.private === true ||
        ["PRIVATE", "RESTRICTED"].includes(String(metadata.visibility).toUpperCase())
      );
    });
    setTemPrivados(privados);
    setConfirmouPrivados(false);
    setManifest(parsed);
  }

  function manifestoConfirmado() {
    if (!manifest || !temPrivados) return manifest;
    return {
      ...manifest,
      objects: (manifest.objects as unknown[]).map((objeto) => {
        const item = registro(objeto);
        return { ...item, metadata: { ...registro(item.metadata), private_scope_explicit: true } };
      }),
    };
  }

  return (
    <Dialog open={aberto} onOpenChange={setAberto}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="mr-2 h-4 w-4" aria-hidden />
          {t("Importar ClickUp")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("Importar Docs do ClickUp")}</DialogTitle>
          <DialogDescription>
            {t(
              "Selecione o manifesto v3 gerado pelo exportador. Primeiro mostramos a prévia; nada é gravado no acervo antes da confirmação.",
            )}
          </DialogDescription>
        </DialogHeader>
        <Label htmlFor="clickup-docs-manifest">{t("Manifesto JSON")}</Label>
        <input
          id="clickup-docs-manifest"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void lerArquivo(event.target.files?.[0])}
        />
        {temPrivados ? (
          <div className="rounded-md border border-warning/40 bg-warning/10 p-3 text-sm">
            <p>
              {t(
                "Docs privados/restritos ficarão disponíveis no Knowledge para toda a organização.",
              )}
            </p>
            {podeImportarPrivados ? (
              <div className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  id="clickup-private-confirm"
                  checked={confirmouPrivados}
                  onChange={(event) => setConfirmouPrivados(event.target.checked)}
                  className="h-4 w-4"
                />
                <Label htmlFor="clickup-private-confirm">{t("Confirmo a inclusão org-wide")}</Label>
              </div>
            ) : (
              <p className="mt-2 font-medium">
                {t("Somente um administrador pode confirmar esta inclusão.")}
              </p>
            )}
          </div>
        ) : null}
        {preview.data ? (
          <p className="text-sm" role="status">
            {t("Inventário")}: {preview.data.total_items}. {t("Aplicáveis")}:{" "}
            {preview.data.applicable_items}. {t("Avisos")}: {preview.data.warnings_count}.
          </p>
        ) : null}
        {(preview.error ?? execute.error) ? (
          <p className="text-danger text-sm" role="alert">
            {(preview.error ?? execute.error)?.message}
          </p>
        ) : null}
        {execute.isSuccess ? (
          <p className="text-sm text-success" role="status">
            {t("Importação enfileirada. O acervo atualizará quando a indexação terminar.")}
          </p>
        ) : null}
        <DialogFooter>
          {!preview.data ? (
            <Button
              disabled={
                !manifest ||
                (temPrivados && (!podeImportarPrivados || !confirmouPrivados)) ||
                preview.isPending
              }
              onClick={() => manifest && preview.mutate(manifestoConfirmado())}
            >
              {t("Ver prévia")}
            </Button>
          ) : (
            <Button
              disabled={execute.isPending || execute.isSuccess}
              onClick={() => execute.mutate(preview.data)}
            >
              {t("Confirmar importação")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
