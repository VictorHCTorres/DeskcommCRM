"use client";

import { useEffect, useState } from "react";
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
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/browser";
import { randomId } from "@/lib/random-id";
import {
  clickUpCoverageBlocksExecution,
  type ClickUpPreviewCoverage,
} from "@/lib/clickup/presentation/coverage";

export { clickUpCoverageBlocksExecution };

type Run = {
  id: string;
  status: string;
  preview_revision: number;
  mapping_revision: number;
  snapshot_hash: string;
  mapping_hash: string | null;
  total_items: number;
  applicable_items: number;
  warnings_count: number;
};
type Connection = { id: string; workspace_id: string; workspace_name: string };
type Coverage = ClickUpPreviewCoverage;
type StatusMap = { status_id: string; name: string; terminal: "open" | "won" | "lost" };
type FieldMap = {
  field_id: string;
  label: string;
  source_type: string;
  action: "native" | "text" | "ignore";
  target_type?: string;
  options?: Array<{ id: string; label: string }>;
};
type ListMap = {
  list_id: string;
  space_id: string;
  folder_id: string | null;
  pipeline_key: string;
  mode: "crm_leads" | "crm_tasks" | "ignore";
  area_name: string;
  group_name: string;
  pipeline_name: string;
  import_subtasks: boolean;
  statuses: StatusMap[];
  fields: FieldMap[];
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const sourceType = (item: Record<string, unknown>) => String(item.source_type ?? item.entity_type);
const sourceId = (item: Record<string, unknown>) => String(item.source_id ?? item.external_id);
const parentSourceId = (item: Record<string, unknown>) =>
  item.parent_source_id ?? item.parent_external_id;
const itemMetadata = (item?: Record<string, unknown>) =>
  record(item?.metadata ?? item?.source_metadata);
async function data<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data?: T; error?: { message?: string } };
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Falha na importação.");
  return body.data;
}

function targetType(source: string) {
  const types: Record<string, string> = {
    short_text: "text",
    text: "text",
    number: "number",
    currency: "currency",
    date: "date",
    checkbox: "checkbox",
    email: "email",
    phone: "phone",
    url: "url",
    drop_down: "dropdown",
    labels: "labels",
    users: "user",
    user: "user",
  };
  return types[source];
}

export function deriveClickUpCrmLists(manifest: unknown): ListMap[] {
  const objects = Array.isArray(record(manifest).objects)
    ? (record(manifest).objects as unknown[])
    : [];
  const indexed = new Map(
    objects.map((raw) => {
      const item = record(raw);
      return [`${sourceType(item)}:${sourceId(item)}`, item] as const;
    }),
  );
  return objects
    .filter((raw) => sourceType(record(raw)) === "list")
    .map((raw) => {
      const item = record(raw);
      const meta = itemMetadata(item);
      const listId = sourceId(item);
      const parentId = String(meta.folder_id ?? parentSourceId(item) ?? "");
      const folder = indexed.get(`folder:${parentId}`);
      const folderId = folder ? parentId : null;
      const folderMeta = itemMetadata(folder);
      const spaceId = String(
        meta.space_id ??
          folderMeta.space_id ??
          (folder ? parentSourceId(folder) : parentId || null) ??
          `space-${listId}`,
      );
      const spaceMeta = itemMetadata(indexed.get(`space:${spaceId}`));
      const relatedStatuses = objects
        .filter((candidate) => {
          const value = record(candidate);
          return (
            sourceType(value) === "status" &&
            String(itemMetadata(value).list_id ?? parentSourceId(value)) === listId
          );
        })
        .map((candidate) => {
          const value = record(candidate);
          const metadata = itemMetadata(value);
          return {
            status_id: String(metadata.source_status_id ?? sourceId(value)),
            name: String(metadata.name ?? metadata.source_status_id ?? sourceId(value)),
            terminal: "open" as const,
          };
        });
      const statuses: StatusMap[] =
        relatedStatuses.length > 0
          ? relatedStatuses
          : (Array.isArray(meta.statuses) ? meta.statuses : []).map((rawStatus) => {
              const status = record(rawStatus);
              return {
                status_id: String(status.id),
                name: String(status.name ?? status.id),
                terminal: "open" as const,
              };
            });
      const relatedFields = objects
        .filter((candidate) => {
          const value = record(candidate);
          return (
            sourceType(value) === "custom_field" &&
            String(itemMetadata(value).list_id ?? parentSourceId(value)) === listId
          );
        })
        .map((candidate) => {
          const value = record(candidate);
          const metadata = itemMetadata(value);
          const source = String(metadata.type ?? metadata.source_type ?? "text");
          const supported = targetType(source);
          const typeConfig = record(metadata.type_config);
          const options = Array.isArray(typeConfig.options)
            ? typeConfig.options.flatMap((rawOption) => {
                const option = record(rawOption);
                const id = String(option.id ?? "");
                return id ? [{ id, label: String(option.name ?? option.label ?? id) }] : [];
              })
            : undefined;
          return {
            field_id: String(metadata.source_field_id ?? sourceId(value)),
            label: String(metadata.name ?? metadata.source_field_id ?? sourceId(value)),
            source_type: source,
            action: supported ? ("native" as const) : ("text" as const),
            ...(supported ? { target_type: supported } : { target_type: "text" }),
            ...(options?.length ? { options } : {}),
          };
        });
      const fields: FieldMap[] =
        relatedFields.length > 0
          ? relatedFields
          : (Array.isArray(meta.fields) ? meta.fields : []).map((rawField) => {
              const field = record(rawField);
              const source = String(field.type ?? "text");
              const supported = targetType(source);
              return {
                field_id: String(field.id),
                label: String(field.name ?? field.id),
                source_type: source,
                action: supported ? ("native" as const) : ("text" as const),
                target_type: supported ?? "text",
              };
            });
      return {
        list_id: listId,
        space_id: spaceId,
        folder_id: folderId,
        pipeline_key: listId,
        mode: "crm_leads",
        area_name: String(meta.space_name ?? spaceMeta.name ?? "ClickUp"),
        group_name: String(meta.folder_name ?? folderMeta.name ?? "Sem pasta"),
        pipeline_name: String(meta.name ?? listId),
        import_subtasks: false,
        statuses,
        fields,
      };
    });
}

export function ImportarClickUpCrm({ podeCriarConexao }: { podeCriarConexao: boolean }) {
  const [lists, setLists] = useState<ListMap[]>([]);
  const [assignees, setAssignees] = useState<"first" | "unassigned">("unassigned");
  const [run, setRun] = useState<Run>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [coverage, setCoverage] = useState<Coverage>();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => {
    void fetch("/api/v1/clickup/connections")
      .then((response) => data<Connection[]>(response))
      .then((items) => {
        setConnections(items);
        setConnectionId(items[0]?.id ?? "");
      })
      .catch(() => setConnections([]));
  }, []);
  const updateList = (index: number, patch: Partial<ListMap>) =>
    setLists((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    );
  async function createConnection() {
    setBusy(true);
    setError(undefined);
    try {
      const created = await data<Connection>(
        await fetch("/api/v1/clickup/connections", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": randomId() },
          body: JSON.stringify({ workspace_id: workspaceId, workspace_name: workspaceName, token }),
        }),
      );
      setConnections((current) => [...current, created]);
      setConnectionId(created.id);
      setToken("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao conectar o ClickUp.");
    } finally {
      setBusy(false);
    }
  }
  async function discover() {
    setBusy(true);
    setError(undefined);
    try {
      const result = await data<{ run: Run }>(
        await fetch("/api/v1/clickup/discovery", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": randomId() },
          body: JSON.stringify({ connection_id: connectionId }),
        }),
      );
      await loadRunInventory(result.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha na descoberta do ClickUp.");
    } finally {
      setBusy(false);
    }
  }
  async function loadRunInventory(discoveredRun: Run) {
    const items: unknown[] = [];
    let after: string | null = null;
    do {
      const params = new URLSearchParams({
        limit: "250",
        entity_types: "list,status,custom_field",
      });
      if (after) params.set("after", after);
      const response = await fetch(`/api/v1/clickup/imports/${discoveredRun.id}?${params}`);
      const body = (await response.json()) as {
        data?: { items?: unknown[] };
        meta?: { cursor?: string | null; has_more?: boolean };
        error?: { message?: string };
      };
      if (!response.ok) throw new Error(body.error?.message ?? "Falha ao paginar a prévia.");
      items.push(...(body.data?.items ?? []));
      after = body.meta?.has_more ? (body.meta.cursor ?? null) : null;
    } while (after);
    setRun(discoveredRun);
    setLists(deriveClickUpCrmLists({ objects: items }));
    setCoverage(
      await data<Coverage>(
        await fetch(`/api/v1/clickup/imports/${discoveredRun.id}/preview-coverage`),
      ),
    );
  }
  async function uploadBundle(file?: File) {
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) {
      setError("O bundle deve ter no máximo 20 MiB.");
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const prepared = await data<{ path: string; token: string }>(
        await fetch("/api/v1/clickup/imports/bundle", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "prepare" }),
        }),
      );
      const { error: uploadError } = await createClient()
        .storage.from("clickup-import-staging")
        .uploadToSignedUrl(prepared.path, prepared.token, file, {
          contentType: "application/json",
        });
      if (uploadError) throw new Error("Não foi possível enviar o bundle.");
      const staged = await data<{ run: Run }>(
        await fetch("/api/v1/clickup/imports/bundle", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": randomId() },
          body: JSON.stringify({ action: "stage", path: prepared.path }),
        }),
      );
      await loadRunInventory(staged.run);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha ao importar o bundle.");
    } finally {
      setBusy(false);
    }
  }
  async function saveMapping() {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      setRun(
        await data<Run>(
          await fetch(`/api/v1/clickup/imports/${run.id}/mapping`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expected_revision: run.mapping_revision,
              mapping: {
                objects: [],
                crm: { lists, create_only: true, multiple_assignees: assignees },
              },
            }),
          }),
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha no mapeamento.");
    } finally {
      setBusy(false);
    }
  }
  async function execute() {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      setRun(
        await data<Run>(
          await fetch(`/api/v1/clickup/imports/${run.id}/execute`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Idempotency-Key": randomId() },
            body: JSON.stringify({
              dry_run: false,
              expected_preview_revision: run.preview_revision,
              expected_snapshot_hash: run.snapshot_hash,
              expected_mapping_hash: run.mapping_hash,
            }),
          }),
        ),
      );
      setQueued(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Falha na execução.");
    } finally {
      setBusy(false);
    }
  }
  const hasBlockingCoverage = coverage ? clickUpCoverageBlocksExecution(coverage) : false;
  const coverageLabels: Record<string, string> = {
    priority: t("Prioridade"),
    tags: t("Tags"),
    start_date: t("Data de início"),
    time_estimate: t("Estimativa"),
    links: t("Relações"),
    checklists: t("Checklists"),
    watchers: t("Watchers"),
    dependencies: t("Dependências"),
    locations: t("Localizações"),
    archived: t("Arquivadas"),
    time_spent: t("Tempo gasto"),
  };
  const classificationLabels: Record<Coverage["dimensions"][number]["classification"], string> = {
    native: t("Nativo"),
    provenance: t("Proveniência"),
    unsupported: t("Não suportado"),
  };
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline">
          <Upload className="mr-2 h-4 w-4" aria-hidden />
          {t("Importar ClickUp")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("Importar ClickUp para o CRM")}</DialogTitle>
          <DialogDescription>
            {t("Uma decisão explícita por List. Won/lost nunca é inferido de “closed”.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="rounded-md border p-3">
            <p className="mb-2 text-sm font-medium">{t("Conexão do ClickUp")}</p>
            {connections.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2">
                <Label htmlFor="clickup-connection">{t("Workspace")}</Label>
                <select
                  id="clickup-connection"
                  className="rounded border p-2"
                  value={connectionId}
                  onChange={(event) => setConnectionId(event.target.value)}
                >
                  {connections.map((connection) => (
                    <option key={connection.id} value={connection.id}>
                      {connection.workspace_name}
                    </option>
                  ))}
                </select>
                <Button disabled={!connectionId || busy} onClick={() => void discover()}>
                  {t("Descobrir estrutura")}
                </Button>
              </div>
            ) : podeCriarConexao ? (
              <div className="grid gap-2 md:grid-cols-4">
                <Input
                  aria-label={t("ID do workspace ClickUp")}
                  placeholder={t("ID do workspace")}
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                />
                <Input
                  aria-label={t("Nome do workspace ClickUp")}
                  placeholder={t("Nome do workspace")}
                  value={workspaceName}
                  onChange={(event) => setWorkspaceName(event.target.value)}
                />
                <Input
                  aria-label={t("Token do ClickUp")}
                  type="password"
                  autoComplete="off"
                  placeholder={t("Token")}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                />
                <Button
                  disabled={!workspaceId || !workspaceName || token.length < 8 || busy}
                  onClick={() => void createConnection()}
                >
                  {t("Conectar")}
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground" role="status">
                {t("Peça a um administrador para conectar este workspace antes da importação.")}
              </p>
            )}
          </div>
          <div>
            <Label htmlFor="clickup-crm-bundle">{t("Ou enviar bundle v3")}</Label>
            <input
              id="clickup-crm-bundle"
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(event) => void uploadBundle(event.target.files?.[0])}
            />
            <p className="text-xs text-muted-foreground">
              {t(
                "O arquivo vai direto ao storage privado; o navegador recebe apenas o resumo paginado.",
              )}
            </p>
          </div>
          {run ? (
            <div className="rounded-md border p-3 text-sm" role="status">
              <p>
                {run.total_items} {t("itens")}; {run.applicable_items} {t("aplicáveis")};{" "}
                {run.warnings_count} {t("avisos")}.
              </p>
              <p>
                Snapshot <code>{run.snapshot_hash.slice(0, 12)}</code> · {t("prévia")} r
                {run.preview_revision} · mapping r{run.mapping_revision}
              </p>
            </div>
          ) : null}
          {coverage ? (
            <section
              className="space-y-3 rounded-md border p-3"
              aria-labelledby="clickup-coverage-title"
            >
              <div>
                <h3 id="clickup-coverage-title" className="font-medium">
                  {t("Cobertura da prévia")}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {coverage.tasks_scanned} {t("Tasks auditadas")} · {t("cobertura")}{" "}
                  {coverage.coverage === "full" ? t("completa") : t("parcial")}
                </p>
              </div>
              {coverage.archive_scope === "active_only" ? (
                <p
                  className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-sm"
                  role="alert"
                >
                  {t(
                    "Importação bloqueada: somente a hierarquia ativa foi auditada. Inclua as Tasks arquivadas e gere uma cobertura completa antes de continuar.",
                  )}
                </p>
              ) : null}
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr>
                      <th className="py-1">{t("Dimensão")}</th>
                      <th>{t("Tratamento")}</th>
                      <th>{t("Encontrados")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {coverage.dimensions.map((dimension) => (
                      <tr key={dimension.key} className="border-t">
                        <td className="py-1.5">{coverageLabels[dimension.key] ?? dimension.key}</td>
                        <td>{classificationLabels[dimension.classification]}</td>
                        <td>
                          {dimension.present}
                          {dimension.detail !== undefined ? (
                            <>
                              {" "}
                              · {dimension.detail} {t("itens")}
                            </>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-sm">
                {t("Responsáveis")}: {coverage.assignees.resolved} {t("resolvidos")} ·{" "}
                {coverage.assignees.unresolved} {t("não resolvidos")} ·{" "}
                {coverage.assignees.assignments} {t("atribuições")}.
              </p>
              {coverage.warnings
                .filter((warning) => warning.blocking)
                .map((warning) => (
                  <p key={warning.code} className="text-sm text-destructive" role="alert">
                    {t("Importação bloqueada")}: {warning.code} ({warning.count}).{" "}
                    {t("Atualize o suporte antes de continuar.")}
                  </p>
                ))}
            </section>
          ) : null}
          {run && !run.mapping_hash ? (
            <>
              <div>
                <Label htmlFor="clickup-assignees">{t("Múltiplos responsáveis")}</Label>
                <select
                  id="clickup-assignees"
                  className="ml-2 rounded border p-2"
                  value={assignees}
                  onChange={(event) => setAssignees(event.target.value as typeof assignees)}
                >
                  <option value="unassigned">{t("Deixar sem responsável")}</option>
                  <option value="first">{t("Usar o primeiro membro ativo")}</option>
                </select>
              </div>
              <div className="space-y-3">
                {lists.map((list, index) => (
                  <details key={list.list_id} className="rounded-md border p-3">
                    <summary className="cursor-pointer font-medium">
                      {list.pipeline_name} · {list.mode}
                    </summary>
                    <div className="mt-3 grid gap-3 md:grid-cols-4">
                      <select
                        aria-label={t("Destino de {nome}").replace("{nome}", list.pipeline_name)}
                        value={list.mode}
                        onChange={(event) =>
                          updateList(index, { mode: event.target.value as ListMap["mode"] })
                        }
                        className="rounded border p-2"
                      >
                        <option value="crm_leads">{t("Negócios")}</option>
                        <option value="crm_tasks">{t("Tarefas operacionais")}</option>
                        <option value="ignore">{t("Ignorar")}</option>
                      </select>
                      {list.mode === "crm_leads" ? (
                        <>
                          <Input
                            aria-label={t("Área")}
                            value={list.area_name}
                            onChange={(event) =>
                              updateList(index, { area_name: event.target.value })
                            }
                          />
                          <Input
                            aria-label={t("Grupo")}
                            value={list.group_name}
                            onChange={(event) =>
                              updateList(index, { group_name: event.target.value })
                            }
                          />
                          <Input
                            aria-label={t("Funil")}
                            value={list.pipeline_name}
                            onChange={(event) =>
                              updateList(index, { pipeline_name: event.target.value })
                            }
                          />
                          <Input
                            aria-label={t("Chave de agrupamento do funil")}
                            value={list.pipeline_key}
                            onChange={(event) =>
                              updateList(index, { pipeline_key: event.target.value })
                            }
                          />
                        </>
                      ) : null}
                    </div>
                    {list.mode !== "ignore" ? (
                      <label className="mt-3 flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={list.import_subtasks}
                          onChange={(event) =>
                            updateList(index, { import_subtasks: event.target.checked })
                          }
                        />
                        {t("Importar subtarefas desta List")}
                      </label>
                    ) : null}
                    {list.mode === "crm_leads" ? (
                      <div className="mt-3 grid gap-4 md:grid-cols-2">
                        <div>
                          <p className="text-sm font-medium">{t("Statuses")}</p>
                          {list.statuses.map((status, statusIndex) => (
                            <div
                              key={status.status_id}
                              className="mt-1 flex items-center justify-between gap-2 text-sm"
                            >
                              <span>{status.name}</span>
                              <select
                                aria-label={t("Resultado de {nome}").replace("{nome}", status.name)}
                                className="rounded border p-1"
                                value={status.terminal}
                                onChange={(event) =>
                                  updateList(index, {
                                    statuses: list.statuses.map((item, itemIndex) =>
                                      itemIndex === statusIndex
                                        ? {
                                            ...item,
                                            terminal: event.target.value as StatusMap["terminal"],
                                          }
                                        : item,
                                    ),
                                  })
                                }
                              >
                                <option value="open">{t("Aberto")}</option>
                                <option value="won">{t("Ganho")}</option>
                                <option value="lost">{t("Perdido")}</option>
                              </select>
                            </div>
                          ))}
                        </div>
                        <div>
                          <p className="text-sm font-medium">
                            {t("Campos")} ({list.fields.length})
                          </p>
                          {list.fields.map((field, fieldIndex) => (
                            <div
                              key={field.field_id}
                              className="mt-1 flex items-center justify-between gap-2 text-sm"
                            >
                              <span className="truncate">
                                {field.label} ({field.source_type})
                              </span>
                              <select
                                aria-label={t("Ação de {nome}").replace("{nome}", field.label)}
                                className="rounded border p-1"
                                value={field.action}
                                onChange={(event) =>
                                  updateList(index, {
                                    fields: list.fields.map((item, itemIndex) =>
                                      itemIndex === fieldIndex
                                        ? {
                                            ...item,
                                            action: event.target.value as FieldMap["action"],
                                            target_type:
                                              event.target.value === "text"
                                                ? "text"
                                                : item.target_type,
                                          }
                                        : item,
                                    ),
                                  })
                                }
                              >
                                <option value="native" disabled={!targetType(field.source_type)}>
                                  {targetType(field.source_type)
                                    ? t("Nativo")
                                    : t("Nativo indisponível para este tipo")}
                                </option>
                                <option value="text">{t("Texto")}</option>
                                <option value="ignore">{t("Ignorar")}</option>
                              </select>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </details>
                ))}
              </div>
            </>
          ) : null}
          {error ? (
            <p className="text-danger text-sm" role="alert">
              {error}
            </p>
          ) : null}
          {queued ? (
            <p className="text-sm text-success" role="status">
              {t("Importação enfileirada no run")} {run?.id}.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          {!run ? null : !run.mapping_hash ? (
            <Button disabled={busy || lists.length === 0} onClick={() => void saveMapping()}>
              {t("Validar mapping")}
            </Button>
          ) : (
            <Button disabled={busy || queued || hasBlockingCoverage} onClick={() => void execute()}>
              {coverage?.coverage === "partial"
                ? t("Importação bloqueada")
                : t("Confirmar importação")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
