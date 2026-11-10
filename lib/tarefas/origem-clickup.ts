type JsonRecord = Record<string, unknown>;

const registro = (valor: unknown): JsonRecord =>
  valor && typeof valor === "object" && !Array.isArray(valor) ? (valor as JsonRecord) : {};
const texto = (valor: unknown): string | null => {
  if (typeof valor !== "string" && typeof valor !== "number") return null;
  const normalizado = String(valor).trim();
  return normalizado || null;
};

export interface OrigemClickUpDaTarefa {
  workspace_id: string | null;
  space_id: string;
  space_name: string;
  folder_id: string | null;
  folder_name: string | null;
  list_id: string;
  list_name: string;
  status: { id: string | null; name: string; type: string | null };
  assignees: Array<{ source_user_id: string; display_name: string }>;
  custom_fields: Array<{
    id: string;
    name: string;
    type: string;
    value: unknown;
    selected_options: Array<{ id: string; label: string }>;
  }>;
  time_spent_ms: number | null;
}

/**
 * Projeta a proveniência do ClickUp que pode sair pela API de Tarefas.
 *
 * `source_metadata` também guarda ids técnicos, campos personalizados e o
 * rastro integral da importação. A tela não precisa receber esse envelope — e,
 * em particular, nunca recebe e-mail de responsável nem payload cru.
 */
export function origemClickUpDaTarefa(sourceMetadata: unknown): OrigemClickUpDaTarefa | null {
  const clickup = registro(registro(sourceMetadata).clickup);
  if (Object.keys(clickup).length === 0) return null;
  const hierarchy = registro(clickup.hierarchy);
  const status = registro(clickup.status);
  const spaceId = texto(hierarchy.space_id);
  const spaceName = texto(hierarchy.space_name);
  const listId = texto(hierarchy.list_id);
  const listName = texto(hierarchy.list_name);
  const statusName = texto(status.name);
  if (!spaceId || !spaceName || !listId || !listName || !statusName) return null;
  const assignees = Array.isArray(clickup.assignees)
    ? clickup.assignees.flatMap((valor) => {
        const assignee = registro(valor);
        const sourceUserId = texto(assignee.source_user_id);
        const displayName = texto(assignee.display_name);
        return sourceUserId && displayName
          ? [{ source_user_id: sourceUserId, display_name: displayName }]
          : [];
      })
    : [];
  const customFields = Array.isArray(clickup.custom_fields)
    ? clickup.custom_fields.flatMap((valor) => {
        const field = registro(valor);
        const id = texto(field.id);
        const name = texto(field.name);
        const type = texto(field.type);
        if (!id || !name || !type) return [];
        const selectedOptions = Array.isArray(field.selected_options)
          ? field.selected_options.flatMap((optionValue) => {
              const option = registro(optionValue);
              const optionId = texto(option.id);
              const label = texto(option.label);
              return optionId && label ? [{ id: optionId, label }] : [];
            })
          : [];
        return [
          {
            id,
            name,
            type,
            value: field.value ?? null,
            selected_options: selectedOptions,
          },
        ];
      })
    : [];
  const gasto = Number(clickup.time_spent_ms);
  return {
    workspace_id: texto(hierarchy.workspace_id),
    space_id: spaceId,
    space_name: spaceName,
    folder_id: texto(hierarchy.folder_id),
    folder_name: texto(hierarchy.folder_name),
    list_id: listId,
    list_name: listName,
    status: { id: texto(status.id), name: statusName, type: texto(status.type) },
    assignees,
    custom_fields: customFields,
    time_spent_ms: Number.isSafeInteger(gasto) && gasto >= 0 ? gasto : null,
  };
}

export function formatarValorCampoClickUp(
  field: OrigemClickUpDaTarefa["custom_fields"][number],
): string {
  if (field.selected_options.length)
    return field.selected_options.map((option) => option.label).join(", ");
  if (Array.isArray(field.value)) return field.value.map(String).join(", ");
  if (field.value && typeof field.value === "object") return JSON.stringify(field.value);
  if (field.value === true) return "Sim";
  if (field.value === false) return "Não";
  return field.value === null || field.value === undefined ? "" : String(field.value);
}

export interface ColecaoClickUpDeTarefas {
  space_id: string;
  space_name: string;
  folder_id: string | null;
  folder_name: string | null;
  list_id: string;
  list_name: string;
  tasks: number;
}

/** Catálogo derivado do destino, não do staging: o que aparece aqui existe no CRM. */
export function catalogoClickUpDasTarefas(
  metadados: readonly unknown[],
): ColecaoClickUpDeTarefas[] {
  const porLista = new Map<string, ColecaoClickUpDeTarefas>();
  for (const metadata of metadados) {
    const origem = origemClickUpDaTarefa(metadata);
    if (!origem) continue;
    const atual = porLista.get(origem.list_id);
    if (atual) atual.tasks += 1;
    else {
      porLista.set(origem.list_id, {
        space_id: origem.space_id,
        space_name: origem.space_name,
        folder_id: origem.folder_id,
        folder_name: origem.folder_name,
        list_id: origem.list_id,
        list_name: origem.list_name,
        tasks: 1,
      });
    }
  }
  return [...porLista.values()].sort(
    (a, b) =>
      a.space_name.localeCompare(b.space_name, "pt-BR") ||
      (a.folder_name ?? "").localeCompare(b.folder_name ?? "", "pt-BR") ||
      a.list_name.localeCompare(b.list_name, "pt-BR"),
  );
}
