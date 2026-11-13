"use client";

import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { COR_DA_PRIORIDADE } from "./estilo-da-prioridade";
import {
  agrupaPorPrazo,
  estaAtrasada,
  estaEncerrada,
  familiasDeTarefas,
  type FaixaDePrazo,
  type PrioridadeDaTarefa,
  type Tarefa,
} from "@/lib/tarefas/tipos";
import {
  ArrowsClockwise,
  Check,
  Kanban,
  PencilSimple,
  Plus,
  Trash,
  UserCircle,
} from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { ComentariosImportados } from "./ComentariosImportados";
import { AssetsImportados } from "./AssetsImportados";
import { RelacoesClickUp } from "./RelacoesClickUp";

interface Props {
  tarefas: Tarefa[];
  podeEditar: boolean;
  aoAlternarConcluida: (tarefa: Tarefa) => Promise<unknown>;
  aoEditar: (tarefa: Tarefa) => void;
  aoApagar: (tarefa: Tarefa) => Promise<unknown>;
  aoCriarSubtarefa?: (tarefa: Tarefa) => void;
  aoCancelarRecorrencia?: (tarefa: Tarefa) => Promise<unknown>;
  /**
   * Mostrar de qual negócio é cada tarefa, com o atalho para ele. A tela de
   * Tarefas mostra; o dossiê não — lá dentro todas são do mesmo negócio, e
   * repetir o nome dele em cada linha só tomaria espaço.
   */
  mostrarNegocio?: boolean;
}

function Linha({
  tarefa,
  podeEditar,
  aoAlternarConcluida,
  aoEditar,
  aoApagar,
  mostrarNegocio,
  nomeDoResponsavel,
  filha = false,
}: {
  tarefa: Tarefa;
  podeEditar: boolean;
  aoAlternarConcluida: (t: Tarefa) => Promise<unknown>;
  aoEditar: (t: Tarefa) => void;
  aoApagar: (t: Tarefa) => Promise<unknown>;
  mostrarNegocio: boolean;
  /** Já resolvido por quem monta a lista; `null` = sem responsável conhecido. */
  nomeDoResponsavel: string | null;
  filha?: boolean;
}) {
  const t = useT();
  const tag = useTagDeIdioma();
  const [ocupada, setOcupada] = useState(false);
  const [confirmando, setConfirmando] = useState(false);

  const encerrada = estaEncerrada(tarefa);
  const atrasada = estaAtrasada(tarefa);

  const rotuloDaPrioridade: Record<PrioridadeDaTarefa, string> = {
    low: t("Baixa"),
    medium: t("Média"),
    high: t("Alta"),
    urgent: t("Urgente"),
  };

  async function comBloqueio(acao: () => Promise<unknown>) {
    setOcupada(true);
    try {
      await acao();
    } finally {
      setOcupada(false);
    }
  }

  return (
    <div
      className={cn(
        "group flex items-start gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-muted/40",
        filha && "ml-7 border-l pl-4",
        encerrada && "opacity-60",
      )}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={encerrada}
        aria-label={encerrada ? t("Reabrir a tarefa") : t("Marcar como concluída")}
        disabled={ocupada || !podeEditar}
        onClick={() => comBloqueio(() => aoAlternarConcluida(tarefa))}
        className={cn(
          // O `before` estende a área de toque a 44px sem crescer o desenho de 16px.
          "relative mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-md border transition-colors pointer-coarse:before:absolute pointer-coarse:before:-inset-3.5 pointer-coarse:before:content-['']",
          encerrada
            ? "border-primary bg-primary text-primary-foreground"
            : "border-muted-foreground/40 hover:border-primary",
        )}
      >
        {encerrada ? <Check size={12} weight="bold" aria-hidden /> : null}
      </button>

      <div className="min-w-0 flex-1">
        <p className={cn("text-sm font-medium", encerrada && "text-muted-foreground line-through")}>
          {tarefa.title}
        </p>
        {tarefa.description ? (
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{tarefa.description}</p>
        ) : null}

        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span
            className={cn(
              "rounded-full px-2 py-0.5 font-medium",
              COR_DA_PRIORIDADE[tarefa.priority],
            )}
          >
            {rotuloDaPrioridade[tarefa.priority]}
          </span>
          <span
            className={cn("text-muted-foreground", atrasada && "font-semibold text-destructive")}
          >
            {tarefa.due_date
              ? new Date(tarefa.due_date).toLocaleString(tag, {
                  day: "2-digit",
                  month: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : t("Sem prazo")}
          </span>
          {nomeDoResponsavel ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <UserCircle size={12} aria-hidden />
              {nomeDoResponsavel}
            </span>
          ) : null}
          {mostrarNegocio && tarefa.lead ? (
            <Link
              href={`/app/leads/${tarefa.lead.id}`}
              className="flex max-w-[16rem] min-w-0 items-center gap-1 text-muted-foreground hover:text-foreground hover:underline"
              title={tarefa.lead.title}
            >
              <Kanban size={12} aria-hidden className="shrink-0" />
              <span className="truncate">{tarefa.lead.title}</span>
            </Link>
          ) : null}
          {tarefa.start_at ? (
            <span className="text-muted-foreground">
              {t("Início")}: {new Date(tarefa.start_at).toLocaleString(tag)}
            </span>
          ) : null}
          {tarefa.time_estimate_ms ? (
            <span className="text-muted-foreground">
              {t("Estimativa")}: {Math.round(tarefa.time_estimate_ms / 3_600_000)}h
            </span>
          ) : null}
        </div>
        {tarefa.tags?.length ? (
          <div className="mt-1 flex flex-wrap gap-1" aria-label={t("Tags do ClickUp")}>
            {tarefa.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
        <ComentariosImportados taskId={tarefa.id} />
        <AssetsImportados taskId={tarefa.id} />
        <RelacoesClickUp taskId={tarefa.id} />
      </div>

      {podeEditar ? (
        // Escondidas até o hover SÓ onde existe hover: no toque elas ficavam
        // invisíveis. Mesma regra de `components/kanban/KanbanCardActions.tsx`.
        <div className="flex shrink-0 items-center gap-1 transition-opacity focus-within:opacity-100 [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon"
            className="md:h-7 md:w-7"
            aria-label={t("Editar a tarefa")}
            onClick={() => aoEditar(tarefa)}
          >
            <PencilSimple size={14} aria-hidden />
          </Button>
          {/*
            Confirmação em DOIS TOQUES no lugar de `confirm()`, que era o do
            original: `window.confirm` é bloqueado em iframe, ignora o tema e
            não passa por `t()` — o texto sai no idioma do navegador, não no da
            organização.
          */}
          {confirmando ? (
            <Button
              variant="destructive"
              size="sm"
              className="px-2 text-[11px] md:h-7"
              disabled={ocupada}
              onClick={() => comBloqueio(() => aoApagar(tarefa))}
            >
              {t("Confirmar")}
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="md:h-7 md:w-7"
              aria-label={t("Apagar a tarefa")}
              onClick={() => setConfirmando(true)}
              onBlur={() => setConfirmando(false)}
            >
              <Trash size={14} aria-hidden />
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ListaDeTarefas({
  tarefas,
  podeEditar,
  aoAlternarConcluida,
  aoEditar,
  aoApagar,
  aoCriarSubtarefa,
  aoCancelarRecorrencia,
  mostrarNegocio = true,
}: Props) {
  const t = useT();
  const usuario = useUser();
  const [expandidas, setExpandidas] = useState<Set<string>>(() => new Set());
  const familias = familiasDeTarefas(tarefas);
  const grupos = agrupaPorPrazo(
    familias.map((familia) => ({
      ...familia.prazoDaFamilia,
      familia,
    })),
  );
  // Os nomes vêm da lista de responsáveis, que é `agent`+ na rota: para quem só
  // lê, a consulta nem sai e a linha fica sem o nome — nunca com um id cru.
  const membros = useAssignableMembers(podeEditar);
  const nomes = new Map((membros.data ?? []).map((m) => [m.user_id, m.full_name]));

  function nomeDoResponsavel(tarefa: Tarefa): string | null {
    if (!tarefa.assigned_to) return null;
    if (tarefa.assigned_to === usuario.id) return t("Eu");
    return nomes.get(tarefa.assigned_to) ?? null;
  }

  const rotuloDaFaixa: Record<FaixaDePrazo, string> = {
    atrasada: t("Atrasadas"),
    hoje: t("Hoje"),
    esta_semana: t("Esta semana"),
    mais_tarde: t("Mais tarde"),
    sem_prazo: t("Sem prazo"),
    encerrada: t("Encerradas"),
  };

  if (grupos.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-10 text-center">
        <p className="text-sm font-medium">{t("Nenhuma tarefa por aqui")}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("Enquanto isto estiver vazio, o que foi combinado vive só na memória de alguém.")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {grupos.map((grupo) => (
        <section key={grupo.faixa}>
          <h2
            className={cn(
              "mb-1 px-3 text-xs font-semibold tracking-wider uppercase",
              grupo.faixa === "atrasada" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {rotuloDaFaixa[grupo.faixa]}
          </h2>
          <div className="rounded-xl border bg-card py-1">
            {grupo.tarefas.map(({ familia }) => {
              const aberta = expandidas.has(familia.raiz.id);
              const concluidas = familia.filhas.filter(estaEncerrada).length;
              const atrasadas = familia.filhas.filter((filha) => estaAtrasada(filha)).length;
              return (
                <div key={familia.raiz.id}>
                  {familia.filhas.length > 0 ||
                  familia.orfa ||
                  podeEditar ||
                  familia.raiz.recurrence_id ? (
                    <div className="flex flex-wrap items-center gap-2 px-3 pt-2 text-[11px] text-muted-foreground">
                      {familia.filhas.length > 0 ? (
                        <button
                          type="button"
                          className="min-h-11 rounded-md px-1 text-left hover:text-foreground lg:min-h-0"
                          aria-expanded={aberta}
                          onClick={() =>
                            setExpandidas((atuais) => {
                              const proximas = new Set(atuais);
                              if (aberta) proximas.delete(familia.raiz.id);
                              else proximas.add(familia.raiz.id);
                              return proximas;
                            })
                          }
                        >
                          {aberta ? "▾" : "▸"} {concluidas}/{familia.filhas.length}{" "}
                          {t("subtarefas")}
                          {atrasadas > 0 ? ` · ${atrasadas} ${t("atrasadas")}` : ""}
                        </button>
                      ) : null}
                      {familia.orfa ? (
                        <span className="font-medium text-amber-700 dark:text-amber-400">
                          {t("Tarefa principal indisponível")}
                        </span>
                      ) : null}
                      {podeEditar && aoCriarSubtarefa && !familia.orfa ? (
                        <button
                          type="button"
                          className="flex min-h-11 items-center gap-1 rounded-md px-1 hover:text-foreground lg:min-h-0"
                          onClick={() => aoCriarSubtarefa(familia.raiz)}
                        >
                          <Plus size={12} aria-hidden /> {t("Adicionar subtarefa")}
                        </button>
                      ) : null}
                      {podeEditar && familia.raiz.recurrence_id && aoCancelarRecorrencia ? (
                        <button
                          type="button"
                          className="flex min-h-11 items-center gap-1 rounded-md px-1 hover:text-destructive lg:min-h-0"
                          onClick={() => aoCancelarRecorrencia(familia.raiz)}
                        >
                          <ArrowsClockwise size={12} aria-hidden /> {t("Cancelar série")}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  <Linha
                    tarefa={familia.raiz}
                    podeEditar={podeEditar}
                    aoAlternarConcluida={aoAlternarConcluida}
                    aoEditar={aoEditar}
                    aoApagar={aoApagar}
                    mostrarNegocio={mostrarNegocio}
                    nomeDoResponsavel={nomeDoResponsavel(familia.raiz)}
                  />
                  {aberta
                    ? familia.filhas.map((filha) => (
                        <Linha
                          key={filha.id}
                          tarefa={filha}
                          filha
                          podeEditar={podeEditar}
                          aoAlternarConcluida={aoAlternarConcluida}
                          aoEditar={aoEditar}
                          aoApagar={aoApagar}
                          mostrarNegocio={mostrarNegocio}
                          nomeDoResponsavel={nomeDoResponsavel(filha)}
                        />
                      ))
                    : null}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}
