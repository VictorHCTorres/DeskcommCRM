"use client";

import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUser } from "@/hooks/auth/AuthProvider";
import { useT } from "@/hooks/i18n/useT";
import { ArrowsClockwise, CalendarBlank, ListChecks, Plus } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";
import { useClickUpTaskCatalog, useTasks } from "@/hooks/tasks/useTasks";
import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { responsavelDoFiltro, type FiltroDeResponsavel } from "@/lib/tarefas/filtro-de-responsavel";
import type {
  ConfiguracaoDeRecorrencia,
  NovaTarefa,
  SituacaoDaTarefa,
  Tarefa,
} from "@/lib/tarefas/tipos";

import { CalendarioDeTarefas } from "./CalendarioDeTarefas";
import { FormularioDeTarefa } from "./FormularioDeTarefa";
import { ListaDeTarefas } from "./ListaDeTarefas";
import { rotuloDoMembro } from "@/lib/users/rotulo-do-atendente";

/** "aberto" não é uma situação do banco: é o filtro que a tela abre por padrão. */
type FiltroDeSituacao = "aberto" | SituacaoDaTarefa;

export function TarefasClient({
  podeEditar,
  minhasDeInicio = false,
}: {
  podeEditar: boolean;
  minhasDeInicio?: boolean;
}) {
  const t = useT();
  const usuario = useUser();
  const [modo, setModo] = useState<"lista" | "calendario">("lista");
  const [situacao, setSituacao] = useState<FiltroDeSituacao>("aberto");
  const [responsavel, setResponsavel] = useState<FiltroDeResponsavel>(
    minhasDeInicio ? "eu" : "todos",
  );
  const [colecaoClickUp, setColecaoClickUp] = useState("todas");
  // `/team/assignable` exige agent: o viewer tomaria 403 (e um authz.denied no
  // audit) a cada visita. Ele fica com Todos, Minhas e Sem responsável.
  const { data: membros } = useAssignableMembers(podeEditar);
  const [emEdicao, setEmEdicao] = useState<Tarefa | null>(null);
  const [formAberto, setFormAberto] = useState(false);
  const [prazoSugerido, setPrazoSugerido] = useState<string | undefined>();
  const [parentTaskId, setParentTaskId] = useState<string | null>(null);
  // O POST pode vencer e o PUT da recorrência falhar. Enquanto esta mesma
  // abertura estiver na tela, Salvar de novo retoma o PUT na tarefa já criada
  // em vez de criar uma irmã duplicada.
  const tarefaCriadaPendente = useRef<string | null>(null);
  // A CHAVE DE REMONTAGEM do formulário. Ele lê o estado inicial das props
  // (nada de `useEffect` sincronizando), então abrir duas vezes seguidas o
  // "Nova tarefa" precisa de uma chave NOVA — senão a segunda abertura traz o
  // que ficou digitado na primeira.
  const [aberturas, setAberturas] = useState(0);

  const {
    tarefas,
    carregando,
    falhou,
    recarregar,
    criarTarefa,
    editarTarefa,
    apagarTarefa,
    alternarConcluida,
    configurarRecorrencia,
    cancelarRecorrencia,
  } = useTasks({
    ...(situacao === "aberto" ? { aberto: true } : { status: situacao }),
    assigned_to: responsavelDoFiltro(responsavel),
    ...(colecaoClickUp === "todas" ? {} : { clickup_list_id: colecaoClickUp }),
  });
  const catalogoClickUp = useClickUpTaskCatalog();

  function abrirNova(dia?: string) {
    tarefaCriadaPendente.current = null;
    setEmEdicao(null);
    setParentTaskId(null);
    setPrazoSugerido(dia);
    setAberturas((n) => n + 1);
    setFormAberto(true);
  }

  function abrirSubtarefa(pai: Tarefa) {
    tarefaCriadaPendente.current = null;
    setEmEdicao(null);
    setParentTaskId(pai.id);
    setPrazoSugerido(undefined);
    setAberturas((n) => n + 1);
    setFormAberto(true);
  }

  function abrirEdicao(tarefa: Tarefa) {
    tarefaCriadaPendente.current = null;
    setEmEdicao(tarefa);
    setParentTaskId(null);
    setPrazoSugerido(undefined);
    setAberturas((n) => n + 1);
    setFormAberto(true);
  }

  async function salvar(entrada: NovaTarefa, recorrencia?: ConfiguracaoDeRecorrencia | null) {
    if (emEdicao) await editarTarefa(emEdicao.id, entrada);
    else {
      let tarefaId = tarefaCriadaPendente.current;
      if (!tarefaId) {
        const criada = await criarTarefa(entrada);
        tarefaId = criada.task.id;
        tarefaCriadaPendente.current = tarefaId;
      }
      if (recorrencia) await configurarRecorrencia(tarefaId, recorrencia);
      tarefaCriadaPendente.current = null;
    }
  }

  function mudarAbertura(aberto: boolean) {
    if (!aberto) tarefaCriadaPendente.current = null;
    setFormAberto(aberto);
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Tarefas")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t(
              "O que ficou combinado, com prazo. Tarefa presa a um negócio aparece na linha do tempo dele.",
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {(catalogoClickUp.data?.collections?.length ?? 0) > 0 ? (
            <Select value={colecaoClickUp} onValueChange={setColecaoClickUp}>
              <SelectTrigger
                aria-label={t("Coleção importada do ClickUp")}
                className="h-11 w-[240px] text-xs lg:h-9"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="todas">{t("Todas as tarefas")}</SelectItem>
                {catalogoClickUp.data?.collections?.map((collection) => (
                  <SelectItem key={collection.list_id} value={collection.list_id}>
                    {collection.space_name} · {collection.list_name} ({collection.tasks})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <Select value={situacao} onValueChange={(v) => setSituacao(v as FiltroDeSituacao)}>
            <SelectTrigger className="h-11 w-[168px] text-xs lg:h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="aberto">{t("Em aberto")}</SelectItem>
              <SelectItem value="pending">{t("Pendente")}</SelectItem>
              <SelectItem value="in_progress">{t("Em andamento")}</SelectItem>
              <SelectItem value="done">{t("Concluída")}</SelectItem>
              <SelectItem value="cancelled">{t("Cancelada")}</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={responsavel}
            onValueChange={(v) => setResponsavel(v as FiltroDeResponsavel)}
          >
            <SelectTrigger
              aria-label={t("Responsável")}
              className="h-11 w-[168px] text-xs lg:h-9"
              data-testid="tarefas-filtro-responsavel"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">{t("Todos")}</SelectItem>
              <SelectItem value="eu">{t("Minhas")}</SelectItem>
              {(membros ?? [])
                .filter((m) => m.user_id !== usuario.id)
                .map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {rotuloDoMembro(m, t)}
                  </SelectItem>
                ))}
              <SelectItem value="ninguem">{t("Sem responsável")}</SelectItem>
            </SelectContent>
          </Select>

          {/* O calendário tem 7 colunas: a 390px não cabe, e no celular fica a lista. */}
          <div className="hidden items-center gap-0.5 rounded-md border bg-muted p-0.5 md:flex">
            <button
              type="button"
              onClick={() => setModo("lista")}
              aria-pressed={modo === "lista"}
              className={cn(
                "flex min-h-11 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors lg:min-h-0",
                modo === "lista"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <ListChecks size={14} aria-hidden />
              {t("Lista")}
            </button>
            <button
              type="button"
              onClick={() => setModo("calendario")}
              aria-pressed={modo === "calendario"}
              className={cn(
                "flex min-h-11 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors lg:min-h-0",
                modo === "calendario"
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <CalendarBlank size={14} aria-hidden />
              {t("Calendário")}
            </button>
          </div>

          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 text-xs md:h-9"
            onClick={() => recarregar()}
            disabled={carregando}
          >
            <ArrowsClockwise size={14} className={cn(carregando && "animate-spin")} aria-hidden />
            {t("Atualizar")}
          </Button>

          {podeEditar && (
            <Button size="sm" className="gap-1.5 text-xs md:h-9" onClick={() => abrirNova()}>
              <Plus size={14} aria-hidden />
              {t("Nova tarefa")}
            </Button>
          )}
        </div>
      </div>

      {falhou ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-sm font-medium text-destructive">
            {t("Não foi possível carregar as tarefas.")}
          </p>
          <Button variant="outline" size="sm" className="mt-3 text-xs" onClick={() => recarregar()}>
            {t("Tentar novamente")}
          </Button>
        </div>
      ) : carregando ? (
        <div className="space-y-3" aria-busy>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 animate-pulse rounded-lg border bg-card" />
          ))}
        </div>
      ) : (
        <>
          {/* A MESMA régua `md` que esconde o seletor esconde o calendário:
              escolhido no tablet deitado e girado para o celular, ele não pode
              ficar preso na tela sem o botão de voltar para a lista. */}
          {modo === "calendario" && (
            <div data-testid="tarefas-calendario" className="hidden md:block">
              <CalendarioDeTarefas
                tarefas={tarefas}
                podeEditar={podeEditar}
                aoAbrirTarefa={abrirEdicao}
                aoClicarNoDia={abrirNova}
              />
            </div>
          )}
          <div data-testid="tarefas-lista" className={cn(modo === "calendario" && "md:hidden")}>
            <ListaDeTarefas
              tarefas={tarefas}
              podeEditar={podeEditar}
              aoAlternarConcluida={alternarConcluida}
              aoEditar={abrirEdicao}
              aoApagar={(tarefa) => apagarTarefa(tarefa.id)}
              aoCriarSubtarefa={abrirSubtarefa}
              aoCancelarRecorrencia={(tarefa) => cancelarRecorrencia(tarefa.id)}
            />
          </div>
        </>
      )}

      <FormularioDeTarefa
        key={aberturas}
        aberto={formAberto}
        aoMudarAbertura={mudarAbertura}
        tarefa={emEdicao}
        prazoSugerido={prazoSugerido}
        parentTaskId={parentTaskId}
        // Filtrando por alguém, a tarefa nova nasce DESSA pessoa: a lista que
        // está na tela filtra por ela, e uma tarefa sem responsável sumiria logo
        // depois de salva. Com "Todos" ou "Sem responsável", nasce sem dono.
        responsavelPadrao={
          responsavel === "eu"
            ? usuario.id
            : responsavel === "todos" || responsavel === "ninguem"
              ? undefined
              : responsavel
        }
        aoSalvar={salvar}
      />
    </div>
  );
}
