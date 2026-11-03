"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import {
  useCreatePipelineView,
  useDeletePipelineView,
  usePipelineViews,
  useUpdatePipelineView,
} from "@/hooks/pipelines/usePipelineViews";
import {
  corpoDaVisaoSchema,
  type CorpoDaVisao,
  type VisaoSalvaDoFunil,
} from "@/lib/kanban/visoes-salvas";

interface Props {
  pipelineId: string;
  activeViewId: string | null;
  requestedViewId?: string | null;
  modified: boolean;
  current: Omit<CorpoDaVisao, "name" | "visibility">;
  canManageShared: boolean;
  onApply: (view: VisaoSalvaDoFunil | null) => void;
  onUnavailable?: () => void;
}

export function SeletorDeVisoes({
  pipelineId,
  activeViewId,
  requestedViewId,
  modified,
  current,
  canManageShared,
  onApply,
  onUnavailable,
}: Props) {
  const t = useT();
  const { data } = usePipelineViews(pipelineId);
  const criar = useCreatePipelineView(pipelineId);
  const atualizar = useUpdatePipelineView(pipelineId);
  const excluir = useDeletePipelineView(pipelineId);
  const [aberto, setAberto] = useState(false);
  const [nome, setNome] = useState("");
  const [visibility, setVisibility] = useState<"personal" | "shared">("personal");
  const views = useMemo(() => data?.data ?? [], [data?.data]);
  const pedidoTratado = useRef<string | null>(null);
  useEffect(() => {
    if (!data || !requestedViewId || pedidoTratado.current === requestedViewId) return;
    pedidoTratado.current = requestedViewId;
    const pedida = views.find((view) => view.id === requestedViewId);
    if (pedida) onApply(pedida);
    else onUnavailable?.();
  }, [data, onApply, onUnavailable, requestedViewId, views]);
  const ativa = views.find((view) => view.id === activeViewId) ?? null;
  const valido = corpoDaVisaoSchema.safeParse({ name: nome || "Visão", visibility, ...current });
  const ocupado = criar.isPending || atualizar.isPending || excluir.isPending;
  const podeEditarAtiva = ativa !== null && (ativa.visibility === "personal" || canManageShared);

  async function salvar() {
    const parsed = corpoDaVisaoSchema.safeParse({ name: nome, visibility, ...current });
    if (!parsed.success) return;
    const resposta = await criar.mutateAsync(parsed.data);
    setAberto(false);
    setNome("");
    onApply(resposta.data);
  }

  async function atualizarAtiva() {
    if (!ativa || !podeEditarAtiva) return;
    const resposta = await atualizar.mutateAsync({ id: ativa.id, body: current });
    onApply(resposta.data);
  }

  async function excluirAtiva() {
    if (!ativa || !podeEditarAtiva) return;
    await excluir.mutateAsync(ativa.id);
    onApply(null);
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="seletor-de-visoes">
      <Select
        value={ativa?.id ?? "manual"}
        onValueChange={(id) => onApply(views.find((view) => view.id === id) ?? null)}
      >
        <SelectTrigger className="h-9 w-52" aria-label={t("Visualização salva")}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="manual">{t("Sem visualização salva")}</SelectItem>
          {views.map((view) => (
            <SelectItem key={view.id} value={view.id}>
              {view.name}
              {view.visibility === "shared" ? ` · ${t("Equipe")}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {ativa && modified && (
        <span className="text-xs text-warning-fg" role="status">
          {t("Modificada")}
        </span>
      )}
      <Button type="button" variant="outline" size="sm" onClick={() => setAberto(true)}>
        {t("Salvar como")}
      </Button>
      {ativa && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={ocupado || !podeEditarAtiva || !modified}
            onClick={atualizarAtiva}
          >
            {t("Atualizar")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={ocupado || !podeEditarAtiva}
            onClick={excluirAtiva}
          >
            {t("Excluir")}
          </Button>
        </>
      )}

      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("Salvar visualização")}</DialogTitle>
            <DialogDescription>
              {t("Guarde a visão, os filtros e a ordenação atuais para abrir novamente.")}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={nome}
            onChange={(event) => setNome(event.target.value)}
            aria-label={t("Nome da visualização")}
            placeholder={t("Ex.: Minha carteira")}
            autoFocus
          />
          <Select
            value={visibility}
            onValueChange={(value) => setVisibility(value as "personal" | "shared")}
          >
            <SelectTrigger aria-label={t("Quem pode usar")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="personal">{t("Só eu")}</SelectItem>
              {canManageShared && <SelectItem value="shared">{t("Toda a equipe")}</SelectItem>}
            </SelectContent>
          </Select>
          {!valido.success && nome.trim() && (
            <p role="alert" className="text-sm text-destructive">
              {valido.error.issues[0]?.message ?? t("Não é possível salvar esta visualização.")}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAberto(false)} disabled={ocupado}>
              {t("Cancelar")}
            </Button>
            <Button onClick={salvar} disabled={ocupado || !nome.trim() || !valido.success}>
              {t("Salvar")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
