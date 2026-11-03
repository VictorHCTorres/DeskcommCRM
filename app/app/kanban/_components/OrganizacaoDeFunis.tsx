"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/hooks/i18n/useT";
import { useCriarGrupoDeFunil, useEditarGrupoDeFunil } from "@/hooks/pipelines/usePipelineGroups";
import { ApiError } from "@/lib/api/types";
import { gruposPorArea, type GrupoDeFunil } from "@/lib/pipelines/grupos";
import { CaretDown, CaretUp } from "@/lib/ui/icons";

function mensagem(error: unknown): string {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Não consegui organizar os funis. Tente de novo.";
}

export function OrganizacaoDeFunis({
  grupos,
  onChange,
}: {
  grupos: GrupoDeFunil[];
  onChange: (grupos: GrupoDeFunil[]) => void;
}) {
  const t = useT();
  const criar = useCriarGrupoDeFunil();
  const editar = useEditarGrupoDeFunil();
  const [novo, setNovo] = useState<
    { kind: "area" | "grupo"; name: string; parent_id: string | null } | undefined
  >();
  const [erro, setErro] = useState<string | null>(null);
  const [destinosDeRestauracao, setDestinosDeRestauracao] = useState<Record<string, string>>({});
  const estrutura = gruposPorArea(grupos);
  const areasAtivas = estrutura.map(({ area }) => area);
  const arquivados = grupos.filter((grupo) => grupo.archived_at !== null);
  const ocupado = criar.isPending || editar.isPending;

  function salvar() {
    if (!novo?.name.trim()) return;
    criar.mutate(
      { name: novo.name.trim(), kind: novo.kind, parent_id: novo.parent_id },
      {
        onSuccess: (resposta) => {
          onChange(resposta.data);
          setNovo(undefined);
          setErro(null);
        },
        onError: (error) => setErro(mensagem(error)),
      },
    );
  }

  function alterar(id: string, patch: Record<string, unknown>) {
    editar.mutate(
      { id, patch },
      {
        onSuccess: (resposta) => {
          onChange(resposta.data);
          setErro(null);
        },
        onError: (error) => setErro(mensagem(error)),
      },
    );
  }

  function moverNaLista(itens: GrupoDeFunil[], indice: number, direcao: -1 | 1) {
    const alvo = itens[indice];
    if (!alvo) return;
    if (direcao === -1) {
      alterar(alvo.id, { depois_de: indice >= 2 ? itens[indice - 2]?.id : null });
      return;
    }
    alterar(alvo.id, { depois_de: itens[indice + 1]?.id });
  }

  return (
    <Card className="space-y-3 p-4" data-testid="organizacao-de-funis">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("Áreas e grupos")}</h2>
          <p className="text-xs text-muted-foreground">
            {t("Use áreas para departamentos e grupos para reunir funis do mesmo trabalho.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setNovo({ kind: "area", name: "", parent_id: null })}
            disabled={ocupado}
            data-testid="nova-area"
          >
            {t("Nova área")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setNovo({ kind: "grupo", name: "", parent_id: estrutura[0]?.area.id ?? null })
            }
            disabled={ocupado || estrutura.length === 0}
            data-testid="novo-grupo"
          >
            {t("Novo grupo")}
          </Button>
        </div>
      </div>

      {novo && (
        <div className="flex flex-col gap-2 rounded-md border p-3 sm:flex-row">
          {novo.kind === "grupo" && (
            <Select
              value={novo.parent_id ?? undefined}
              onValueChange={(parent_id) => setNovo({ ...novo, parent_id })}
            >
              <SelectTrigger aria-label={t("Área do novo grupo")} className="sm:w-56">
                <SelectValue placeholder={t("Escolha a área")} />
              </SelectTrigger>
              <SelectContent>
                {estrutura.map(({ area }) => (
                  <SelectItem key={area.id} value={area.id}>
                    {area.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Input
            autoFocus
            value={novo.name}
            onChange={(event) => setNovo({ ...novo, name: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") salvar();
              if (event.key === "Escape") setNovo(undefined);
            }}
            aria-label={novo.kind === "area" ? t("Nome da nova área") : t("Nome do novo grupo")}
            placeholder={novo.kind === "area" ? t("Ex.: Comercial") : t("Ex.: Prospecção")}
          />
          <Button
            onClick={salvar}
            disabled={ocupado || !novo.name.trim() || (novo.kind === "grupo" && !novo.parent_id)}
          >
            {t("Salvar")}
          </Button>
          <Button variant="ghost" onClick={() => setNovo(undefined)} disabled={ocupado}>
            {t("Cancelar")}
          </Button>
        </div>
      )}

      {estrutura.length > 0 && (
        <div className="space-y-2" data-testid="estrutura-de-funis">
          {estrutura.map(({ area, grupos: filhos }, areaIndex) => (
            <div key={area.id} className="rounded-md border p-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-sm">{area.name}</strong>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => moverNaLista(areasAtivas, areaIndex, -1)}
                    disabled={ocupado || areaIndex === 0}
                    aria-label={`${t("Mover área para cima")}: ${area.name}`}
                  >
                    <CaretUp aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => moverNaLista(areasAtivas, areaIndex, 1)}
                    disabled={ocupado || areaIndex === areasAtivas.length - 1}
                    aria-label={`${t("Mover área para baixo")}: ${area.name}`}
                  >
                    <CaretDown aria-hidden />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => alterar(area.id, { archived: true })}
                    disabled={ocupado}
                  >
                    {t("Arquivar área")}
                  </Button>
                </div>
              </div>
              <div className="mt-2 space-y-2">
                {filhos.length === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    {t("Nenhum grupo nesta área")}
                  </span>
                ) : (
                  filhos.map((grupo, grupoIndex) => (
                    <div
                      key={grupo.id}
                      className="flex flex-wrap items-center gap-1 rounded-md bg-muted px-2 py-1 text-xs"
                    >
                      <span className="mr-auto font-medium">{grupo.name}</span>
                      <Select
                        value={grupo.parent_id ?? undefined}
                        onValueChange={(parent_id) => alterar(grupo.id, { parent_id })}
                        disabled={ocupado}
                      >
                        <SelectTrigger
                          className="h-8 w-44"
                          aria-label={`${t("Mover grupo para outra área")}: ${grupo.name}`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {areasAtivas.map((areaDaOpcao) => (
                            <SelectItem key={areaDaOpcao.id} value={areaDaOpcao.id}>
                              {areaDaOpcao.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => moverNaLista(filhos, grupoIndex, -1)}
                        disabled={ocupado || grupoIndex === 0}
                        aria-label={`${t("Mover grupo para cima")}: ${grupo.name}`}
                      >
                        <CaretUp aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => moverNaLista(filhos, grupoIndex, 1)}
                        disabled={ocupado || grupoIndex === filhos.length - 1}
                        aria-label={`${t("Mover grupo para baixo")}: ${grupo.name}`}
                      >
                        <CaretDown aria-hidden />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => alterar(grupo.id, { archived: true })}
                        disabled={ocupado}
                        aria-label={`${t("Arquivar grupo")}: ${grupo.name}`}
                      >
                        {t("Arquivar")}
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {arquivados.length > 0 && (
        <details className="rounded-md border p-3" data-testid="grupos-arquivados">
          <summary className="cursor-pointer text-sm font-medium">
            {t("Áreas e grupos arquivados")} ({arquivados.length})
          </summary>
          <div className="mt-3 space-y-2">
            {arquivados.map((item) => {
              const destinoPadrao =
                item.kind === "grupo"
                  ? (areasAtivas.find((area) => area.id === item.parent_id)?.id ??
                    areasAtivas[0]?.id)
                  : undefined;
              const destino = destinosDeRestauracao[item.id] ?? destinoPadrao;
              return (
                <div
                  key={item.id}
                  className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-sm"
                >
                  <span className="mr-auto">
                    {item.name} · {item.kind === "area" ? t("Área") : t("Grupo")}
                  </span>
                  {item.kind === "grupo" && (
                    <Select
                      value={destino}
                      onValueChange={(parent_id) =>
                        setDestinosDeRestauracao((atuais) => ({
                          ...atuais,
                          [item.id]: parent_id,
                        }))
                      }
                      disabled={ocupado || areasAtivas.length === 0}
                    >
                      <SelectTrigger
                        className="h-8 w-44"
                        aria-label={`${t("Área para restaurar grupo")}: ${item.name}`}
                      >
                        <SelectValue placeholder={t("Escolha a área")} />
                      </SelectTrigger>
                      <SelectContent>
                        {areasAtivas.map((area) => (
                          <SelectItem key={area.id} value={area.id}>
                            {area.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={ocupado || (item.kind === "grupo" && !destino)}
                    onClick={() =>
                      alterar(item.id, {
                        archived: false,
                        ...(item.kind === "grupo" && destino ? { parent_id: destino } : {}),
                      })
                    }
                    aria-label={`${t("Restaurar")} ${item.kind === "area" ? t("Área") : t("Grupo")}: ${item.name}`}
                  >
                    {t("Restaurar")}
                  </Button>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {erro && (
        <p className="text-sm text-destructive" role="alert" aria-live="assertive">
          {erro}
        </p>
      )}
    </Card>
  );
}
