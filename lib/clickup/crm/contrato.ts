import { createHash } from "node:crypto";
import { z } from "zod";

export const CLICKUP_CRM_BATCH_SIZE = 40;
export const CLICKUP_CRM_MAX_FIELDS_PER_PIPELINE = 50;
export const CLICKUP_CRM_IMPORTED_FIELDS_WITH_ASSETS = CLICKUP_CRM_MAX_FIELDS_PER_PIPELINE;

export const clickupCrmListModeSchema = z.enum(["crm_leads", "crm_tasks", "ignore"]);
export const clickupCrmTerminalSchema = z.enum(["open", "won", "lost"]);
export const clickupCrmSupportedFieldTypeSchema = z.enum([
  "text",
  "number",
  "date",
  "datetime",
  "checkbox",
  "email",
  "phone",
  "url",
  "currency",
  "dropdown",
  "labels",
  "user",
]);
export const clickupCrmUnsupportedFieldTypeSchema = z.enum([
  "formula",
  "rollup",
  "location",
  "relationship",
]);

const statusMappingSchema = z
  .object({
    status_id: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(255),
    terminal: clickupCrmTerminalSchema,
  })
  .strict();

const fieldMappingSchema = z
  .object({
    field_id: z.string().trim().min(1).max(512),
    label: z.string().trim().min(1).max(120),
    source_type: z.string().trim().min(1).max(80),
    action: z.enum(["native", "text", "ignore"]),
    target_type: clickupCrmSupportedFieldTypeSchema.optional(),
    options: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(512),
            label: z.string().trim().min(1).max(255),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict()
  .superRefine((field, context) => {
    const unsupported = clickupCrmUnsupportedFieldTypeSchema.safeParse(field.source_type).success;
    if (unsupported && field.action === "native") {
      context.addIssue({
        code: "custom",
        path: ["action"],
        message: "Campos formula/rollup/location/relationship exigem text ou ignore explícito.",
      });
    }
    if (field.action !== "ignore" && !field.target_type) {
      context.addIssue({
        code: "custom",
        path: ["target_type"],
        message: "Campo importado exige tipo de destino explícito.",
      });
    }
    if (
      (field.target_type === "dropdown" || field.target_type === "labels") &&
      field.action !== "ignore" &&
      !field.options?.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Campo de opções importado exige opções estáveis.",
      });
    }
  });

export const clickupCrmListMappingSchema = z
  .object({
    list_id: z.string().trim().min(1).max(512),
    space_id: z.string().trim().min(1).max(512).optional(),
    folder_id: z.string().trim().min(1).max(512).nullable().optional(),
    /** Chave estável escolhida no mapping; Lists com a mesma chave convergem no mesmo funil. */
    pipeline_key: z.string().trim().min(1).max(512).optional(),
    mode: clickupCrmListModeSchema,
    area_name: z.string().trim().min(1).max(120).optional(),
    group_name: z.string().trim().min(1).max(120).optional(),
    pipeline_name: z.string().trim().min(1).max(120).optional(),
    import_subtasks: z.literal(true).default(true),
    statuses: z.array(statusMappingSchema).max(100).default([]),
    fields: z.array(fieldMappingSchema).max(200).default([]),
  })
  .strict()
  .superRefine((mapping, context) => {
    if (mapping.mode === "crm_leads") {
      for (const key of [
        "space_id",
        "pipeline_key",
        "area_name",
        "group_name",
        "pipeline_name",
      ] as const) {
        if (!mapping[key]) {
          context.addIssue({ code: "custom", path: [key], message: "Destino CRM obrigatório." });
        }
      }
      const imported = mapping.fields.filter((field) => field.action !== "ignore");
      if (imported.length > CLICKUP_CRM_IMPORTED_FIELDS_WITH_ASSETS) {
        context.addIssue({
          code: "custom",
          path: ["fields"],
          message: "Um funil aceita no máximo 50 campos importados.",
        });
      }
    }
    if (
      mapping.mode !== "crm_leads" &&
      mapping.statuses.some((status) => status.terminal !== "open")
    ) {
      context.addIssue({
        code: "custom",
        path: ["statuses"],
        message: "Won/lost só se aplica a listas mapeadas para negócios.",
      });
    }
    const unique = <T>(values: T[]) => new Set(values).size === values.length;
    if (!unique(mapping.statuses.map((status) => status.status_id))) {
      context.addIssue({ code: "custom", path: ["statuses"], message: "Status duplicado." });
    }
    if (!unique(mapping.fields.map((field) => field.field_id))) {
      context.addIssue({ code: "custom", path: ["fields"], message: "Campo duplicado." });
    }
  });

export const clickupCrmMappingConfigSchema = z
  .object({
    lists: z.array(clickupCrmListMappingSchema).max(500),
    create_only: z.literal(true).default(true),
    /** Quando ligado, a API não confia apenas no botão: exige coleta live completa. */
    require_complete_sidecar: z.literal(true).default(true),
    /** O CRM tem um único owner: múltiplos responsáveis nunca são inferidos. */
    multiple_assignees: z.enum(["first", "unassigned"]).default("unassigned"),
  })
  .strict()
  .superRefine((mapping, context) => {
    if (new Set(mapping.lists.map((list) => list.list_id)).size !== mapping.lists.length) {
      context.addIssue({ code: "custom", path: ["lists"], message: "List duplicada no mapping." });
    }
    for (const [index, list] of mapping.lists.entries()) {
      if (list.mode === "ignore") {
        context.addIssue({
          code: "custom",
          path: ["lists", index, "mode"],
          message: "A migração completa não permite ignorar Lists do ClickUp.",
        });
      }
    }
    const fieldsByPipeline = new Map<string, Set<string>>();
    const statusesByPipeline = new Map<string, string>();
    const fieldDecisionsByPipeline = new Map<string, string>();
    for (const list of mapping.lists) {
      if (list.mode !== "crm_leads") continue;
      const destination = list.pipeline_key!;
      const fields = fieldsByPipeline.get(destination) ?? new Set<string>();
      for (const field of list.fields) if (field.action !== "ignore") fields.add(field.field_id);
      fieldsByPipeline.set(destination, fields);
      for (const status of list.statuses) {
        const key = `${destination}\u0000${status.status_id}`;
        const signature = `${status.name}\u0000${status.terminal}`;
        if (statusesByPipeline.has(key) && statusesByPipeline.get(key) !== signature) {
          context.addIssue({
            code: "custom",
            path: ["lists"],
            message: "Status compartilhado no mesmo funil exige nome e resultado consistentes.",
          });
        }
        statusesByPipeline.set(key, signature);
      }
      for (const field of list.fields) {
        const key = `${destination}\u0000${field.field_id}`;
        const signature = `${field.action}\u0000${field.target_type ?? ""}\u0000${JSON.stringify(field.options ?? [])}`;
        if (fieldDecisionsByPipeline.has(key) && fieldDecisionsByPipeline.get(key) !== signature) {
          context.addIssue({
            code: "custom",
            path: ["lists"],
            message: "Campo herdado no mesmo funil exige uma decisão consistente.",
          });
        }
        fieldDecisionsByPipeline.set(key, signature);
      }
    }
    if (
      [...fieldsByPipeline.values()].some(
        (fields) => fields.size > CLICKUP_CRM_IMPORTED_FIELDS_WITH_ASSETS,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["lists"],
        message: "Lists do mesmo funil somam mais de 50 campos.",
      });
    }
  });

export type ClickUpCrmMappingConfig = z.output<typeof clickupCrmMappingConfigSchema>;
export type ClickUpCrmListMapping = z.output<typeof clickupCrmListMappingSchema>;

/** Chave estável, opaca e dentro do contrato de `settings.fields[].key`. */
export function clickupCustomFieldKey(fieldId: string): string {
  return `cu_${createHash("sha256").update(fieldId).digest("hex").slice(0, 20)}`;
}

export function validateEveryListIsMapped(
  listIds: readonly string[],
  mapping: ClickUpCrmMappingConfig,
) {
  const configured = new Set(mapping.lists.map((list) => list.list_id));
  const missing = [...new Set(listIds)].filter((id) => !configured.has(id));
  return { ok: missing.length === 0, missing } as const;
}

export function checklistToMarkdown(
  checklist:
    | readonly {
        name: string;
        resolved?: boolean | number;
        items?: readonly { name: string; resolved?: boolean }[];
      }[]
    | null
    | undefined,
): string | null {
  if (!checklist?.length) return null;
  return checklist
    .flatMap((group) =>
      group.items
        ? [
            `### ${group.name.trim()}`,
            ...(group.items.length
              ? group.items.map((item) => `- [${item.resolved ? "x" : " "}] ${item.name.trim()}`)
              : ["- _(sem itens)_"]),
          ]
        : [`- [${group.resolved ? "x" : " "}] ${group.name.trim()}`],
    )
    .join("\n");
}

export function clickupAssigneeEmail(
  metadata: Record<string, unknown>,
  strategy: "first" | "unassigned",
): string | null {
  const raw = Array.isArray(metadata.assignees)
    ? metadata.assignees
    : metadata.assignee
      ? [metadata.assignee]
      : [];
  const emails = raw
    .map((assignee) =>
      assignee && typeof assignee === "object" && !Array.isArray(assignee)
        ? (assignee as Record<string, unknown>).email
        : null,
    )
    .filter((email): email is string => typeof email === "string" && Boolean(email.trim()))
    .map((email) => email.trim().toLowerCase());
  if (emails.length === 0 || (emails.length > 1 && strategy === "unassigned")) return null;
  return emails[0] ?? null;
}
