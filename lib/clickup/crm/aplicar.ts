import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  checklistToMarkdown,
  clickupAssigneeEmail,
  clickupCrmMappingConfigSchema,
  clickupCustomFieldKey,
  type ClickUpCrmListMapping,
} from "@/lib/clickup/crm/contrato";
import {
  clickUpFidelityMetadata,
  clickUpPriorityToCrm,
  clickUpTagNames,
  epochMillisecondsToIso,
  normalizeNonNegativeMilliseconds,
} from "@/lib/clickup/crm/fidelidade";
import { applyClickUpCrmRelation } from "@/lib/clickup/crm/relacoes";

type Row = Record<string, unknown>;

export function clickupDeterministicId(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function slug(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 20)}`;
}

function fieldType(type: string) {
  const mapped: Record<string, string> = {
    checkbox: "boolean",
    dropdown: "select",
    labels: "multiselect",
    datetime: "date",
    user: "text",
  };
  return mapped[type] ?? type;
}

export function convertClickUpFieldValue(type: string, value: unknown): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (["text", "phone"].includes(type)) {
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  }
  if (type === "email") {
    const text = String(value).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(text)) throw new Error("clickup_custom_field_invalid_email");
    return text;
  }
  if (type === "url") {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("clickup_custom_field_invalid_url");
    return url.toString();
  }
  if (type === "currency") {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) throw new Error("clickup_custom_field_invalid_currency");
    return parsed;
  }
  if (type === "user") {
    if (typeof value === "object" && value && !Array.isArray(value)) {
      const user = value as Row;
      return String(user.email ?? user.id ?? user.username ?? "");
    }
    return String(value);
  }
  if (type === "number") {
    const parsed = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(parsed)) throw new Error("clickup_custom_field_invalid_number");
    return parsed;
  }
  if (type === "checkbox") {
    if (value === true || value === false) return value;
    if (value === "true" || value === 1) return true;
    if (value === "false" || value === 0) return false;
    throw new Error("clickup_custom_field_invalid_boolean");
  }
  if (type === "date" || type === "datetime") {
    const numeric =
      typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
    const date = new Date(numeric ?? String(value));
    if (Number.isNaN(date.getTime())) throw new Error("clickup_custom_field_invalid_date");
    return type === "date" ? date.toISOString().slice(0, 10) : date.toISOString();
  }
  if (type === "labels") return Array.isArray(value) ? value.map(String) : [String(value)];
  if (type === "dropdown") {
    if (typeof value === "object" && value && !Array.isArray(value)) {
      const option = value as Row;
      const stable = option.id ?? option.value;
      if (stable === undefined) throw new Error("clickup_custom_field_invalid_option");
      return String(stable);
    }
    return String(value);
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function normalizeClickUpDueDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric =
    typeof value === "number" ? value : /^\d+$/.test(String(value)) ? Number(value) : null;
  const date = new Date(numeric ?? String(value));
  if (Number.isNaN(date.getTime())) throw new Error("clickup_due_date_invalid");
  return date.toISOString();
}

function metadata(item: Row): Row {
  return item.source_metadata && typeof item.source_metadata === "object"
    ? (item.source_metadata as Row)
    : {};
}

function listFor(item: Row, mappings: ClickUpCrmListMapping[]) {
  const meta = metadata(item);
  const listId = item.entity_type === "list" ? item.external_id : meta.list_id;
  return mappings.find((mapping) => mapping.list_id === String(listId ?? ""));
}

export async function resolveClickUpTaskAncestry(
  parentExternalId: string,
  listId: string,
  loadParent: (externalId: string) => Promise<string | null | undefined>,
) {
  let ancestorExternalId = parentExternalId;
  let parentTaskExternalId: string | null = null;
  for (let depth = 0; depth < 100; depth += 1) {
    const next = await loadParent(ancestorExternalId);
    if (next === undefined) throw new Error("clickup_parent_task_not_staged");
    if (!next || next === listId) return { ancestorExternalId, parentTaskExternalId };
    if (depth === 0) parentTaskExternalId = ancestorExternalId;
    ancestorExternalId = next;
  }
  throw new Error("clickup_parent_chain_too_deep");
}

async function upsertPipelineGroup(db: SupabaseClient, value: Row) {
  const { error } = await db
    .from("crm_pipeline_groups")
    .upsert(value, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`crm_pipeline_groups: ${error.message}`);
}

async function upsertPipeline(db: SupabaseClient, value: Row) {
  const { error } = await db
    .from("crm_pipelines")
    .upsert(value, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`crm_pipelines: ${error.message}`);
}

async function upsertStage(db: SupabaseClient, value: Row) {
  const { error } = await db
    .from("crm_stages")
    .upsert(value, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`crm_stages: ${error.message}`);
}

async function upsertTask(db: SupabaseClient, value: Row) {
  const { error } = await db
    .from("crm_tasks")
    .upsert(value, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`crm_tasks: ${error.message}`);
}

async function upsertLead(db: SupabaseClient, value: Row) {
  const { error } = await db
    .from("crm_leads")
    .upsert(value, { onConflict: "id", ignoreDuplicates: true });
  if (error) throw new Error(`crm_leads: ${error.message}`);
}

async function receipt(
  db: SupabaseClient,
  run: Row,
  item: Row,
  entityType: string,
  externalId: string,
  target: Row,
) {
  const { error } = await db.from("clickup_object_mappings").upsert(
    {
      organization_id: run.organization_id,
      connection_id: run.connection_id,
      workspace_id: run.workspace_id,
      entity_type: entityType,
      external_id: externalId,
      source_hash: item.source_hash,
      mapping_revision: run.mapping_revision,
      created_by: run.created_by,
      ...target,
    },
    {
      onConflict: "organization_id,workspace_id,entity_type,external_id",
      // create_only: um snapshot novo não pode sobrescrever o hash do receipt
      // anterior e fingir que o domínio foi atualizado. Sem receipt (crash), o
      // rerun converge os IDs determinísticos e esta inserção completa o commit.
      ignoreDuplicates: true,
    },
  );
  if (error) throw new Error(`clickup_object_mappings: ${error.message}`);
}

const directoryCache = new WeakMap<
  SupabaseClient,
  Map<string, { expiresAt: number; value: Promise<Map<string, string>> }>
>();

export async function loadClickUpMemberDirectory(db: SupabaseClient, organizationId: string) {
  const byOrg = directoryCache.get(db) ?? new Map();
  directoryCache.set(db, byOrg);
  const cached = byOrg.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const value = (async () => {
    const { data: memberships, error } = await db
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", organizationId)
      .is("revoked_at", null)
      .not("accepted_at", "is", null);
    if (error) throw new Error(`clickup_member_directory_unavailable:${error.message}`);
    const activeIds = new Set((memberships ?? []).map((row) => String(row.user_id)));
    const directory = new Map<string, string>();
    for (let page = 1; page <= 50; page += 1) {
      const response = await db.auth.admin.listUsers({ page, perPage: 1000 });
      if (response.error)
        throw new Error(`clickup_auth_directory_unavailable:${response.error.message}`);
      for (const user of response.data.users) {
        if (user.email && activeIds.has(user.id)) directory.set(user.email.toLowerCase(), user.id);
      }
      if (response.data.users.length < 1000) break;
    }
    return directory;
  })();
  byOrg.set(organizationId, { expiresAt: Date.now() + 60_000, value });
  return value;
}

async function activeMemberByEmail(
  db: SupabaseClient,
  organizationId: string,
  itemMetadata: Row,
  strategy: "first" | "unassigned",
) {
  const email = clickupAssigneeEmail(itemMetadata, strategy);
  return email ? ((await loadClickUpMemberDirectory(db, organizationId)).get(email) ?? null) : null;
}

async function aplicarLista(
  db: SupabaseClient,
  run: Row,
  item: Row,
  mapping: ClickUpCrmListMapping,
  allMappings: ClickUpCrmListMapping[],
  writeListReceipt = true,
) {
  if (mapping.mode === "ignore") return "skipped" as const;
  if (mapping.mode === "crm_tasks") return "succeeded" as const;
  const org = String(run.organization_id);
  const areaId = clickupDeterministicId(org, "clickup-area", mapping.space_id!);
  const groupId = clickupDeterministicId(
    org,
    "clickup-group",
    mapping.space_id!,
    mapping.folder_id ?? `__root__:${mapping.space_id}`,
  );
  const pipelineId = clickupDeterministicId(org, "clickup-pipeline", mapping.pipeline_key!);
  await upsertPipelineGroup(db, {
    id: areaId,
    organization_id: org,
    name: mapping.area_name,
    kind: "area",
    position: 1000,
  });
  await upsertPipelineGroup(db, {
    id: groupId,
    organization_id: org,
    name: mapping.group_name,
    kind: "grupo",
    parent_id: areaId,
    position: 1000,
  });
  const fields = buildClickUpPipelineFields(allMappings, mapping.pipeline_key!);
  await upsertPipeline(db, {
    id: pipelineId,
    organization_id: org,
    group_id: groupId,
    name: mapping.pipeline_name,
    slug: slug("cu", mapping.pipeline_key!),
    position: 1000,
    settings: { fields, canonical_tags: [], lost_reasons: ["Importado do ClickUp"] },
  });
  for (const [position, status] of mapping.statuses.entries()) {
    await upsertStage(db, {
      id: clickupDeterministicId(org, "clickup-stage", mapping.pipeline_key!, status.status_id),
      organization_id: org,
      pipeline_id: pipelineId,
      name: status.name,
      slug: slug("cu", status.status_id),
      position: (position + 1) * 1000,
      is_won: status.terminal === "won",
      is_lost: status.terminal === "lost",
    });
  }
  if (writeListReceipt) {
    await receipt(db, run, item, "space", mapping.space_id!, { pipeline_group_id: areaId });
    await receipt(db, run, item, "folder", mapping.folder_id ?? `__root__:${mapping.space_id}`, {
      pipeline_group_id: groupId,
    });
    await receipt(db, run, item, "list", String(item.external_id), { pipeline_id: pipelineId });
  }
  return "succeeded" as const;
}

export function buildClickUpPipelineFields(
  allMappings: ClickUpCrmListMapping[],
  pipelineKey: string,
) {
  const importedFields = allMappings
    .filter((candidate) => candidate.pipeline_key === pipelineKey)
    .flatMap((candidate) => candidate.fields)
    .filter((field) => field.action !== "ignore")
    .filter(
      (field, index, all) =>
        all.findIndex((candidate) => candidate.field_id === field.field_id) === index,
    );
  const fields = importedFields.map((field) => ({
    key: clickupCustomFieldKey(field.field_id),
    label: field.label,
    type: field.action === "text" ? "text" : fieldType(field.target_type ?? "text"),
    required: false,
    ...(field.target_type === "dropdown" || field.target_type === "labels"
      ? {
          options: (field.options ?? []).map((option) => ({
            value: option.id,
            label: option.label,
          })),
        }
      : {}),
  }));
  if (fields.length < 50) {
    fields.push({
      key: "Anexos_ClickUp",
      label: "Anexos ClickUp",
      type: "file",
      required: false,
    });
  }
  return fields;
}

async function aplicarBinding(
  db: SupabaseClient,
  run: Row,
  item: Row,
  mapping: ClickUpCrmListMapping,
  allMappings: ClickUpCrmListMapping[],
) {
  if (mapping.mode !== "crm_leads") return "skipped" as const;
  await aplicarLista(db, run, item, mapping, allMappings, false);
  const meta = metadata(item);
  const org = String(run.organization_id);
  if (item.entity_type === "status") {
    const statusId = String(meta.source_status_id ?? "");
    const status = mapping.statuses.find((candidate) => candidate.status_id === statusId);
    if (!status) throw new Error(`clickup_status_not_mapped:${statusId || "missing"}`);
    await receipt(db, run, item, "status", String(item.external_id), {
      stage_id: clickupDeterministicId(org, "clickup-stage", mapping.pipeline_key!, statusId),
    });
    return "succeeded" as const;
  }
  const fieldId = String(meta.source_field_id ?? "");
  const field = mapping.fields.find((candidate) => candidate.field_id === fieldId);
  if (!field) throw new Error(`clickup_field_not_mapped:${fieldId || "missing"}`);
  if (field.action === "ignore") return "skipped" as const;
  await receipt(db, run, item, "custom_field", String(item.external_id), {
    pipeline_id: clickupDeterministicId(org, "clickup-pipeline", mapping.pipeline_key!),
    field_key: clickupCustomFieldKey(fieldId),
  });
  return "succeeded" as const;
}

async function aplicarTask(
  db: SupabaseClient,
  run: Row,
  item: Row,
  mapping: ClickUpCrmListMapping,
  allMappings: ClickUpCrmListMapping[],
  assigneeStrategy: "first" | "unassigned",
) {
  if (mapping.mode === "ignore") return "skipped" as const;
  const org = String(run.organization_id);
  const meta = metadata(item);
  const externalId = String(item.external_id);
  const parentExternalId = item.parent_external_id ? String(item.parent_external_id) : null;
  const title = String(meta.name ?? meta.title ?? `ClickUp ${externalId}`).trim();
  const attachmentStatus = String(meta.attachment_status ?? "none");
  const attachmentCount =
    meta.attachment_count !== null && Number.isInteger(Number(meta.attachment_count))
      ? Number(meta.attachment_count)
      : Array.isArray(meta.attachments)
        ? meta.attachments.length
        : 0;
  const attachmentNotice =
    attachmentStatus === "unknown_not_exported"
      ? "[Anexos do ClickUp: unknown_not_exported]"
      : attachmentCount > 0
        ? `[Anexos do ClickUp: skipped_not_imported (${attachmentCount})]`
        : null;
  const description =
    [
      meta.description,
      checklistToMarkdown(
        Array.isArray(meta.checklists)
          ? (meta.checklists as Array<{ name: string; resolved?: boolean }>)
          : null,
      ),
      attachmentNotice,
    ]
      .filter(Boolean)
      .join("\n\n") || null;
  const dueDate = normalizeClickUpDueDate(meta.due_date);
  const owner = await activeMemberByEmail(db, org, meta, assigneeStrategy);
  const tags = clickUpTagNames(meta.tags);
  const priority = clickUpPriorityToCrm(meta.priority);
  const startAt = epochMillisecondsToIso(meta.start_date);
  const timeEstimateMs = normalizeNonNegativeMilliseconds(meta.time_estimate);
  const clickupMetadata = clickUpFidelityMetadata(meta);

  if (parentExternalId && !mapping.import_subtasks) return "skipped" as const;

  if (mapping.mode === "crm_tasks") {
    const taskId = clickupDeterministicId(org, "clickup-task", externalId);
    const parentTaskId = parentExternalId
      ? clickupDeterministicId(org, "clickup-task", parentExternalId)
      : null;
    if (parentTaskId) {
      const { data: parent } = await db
        .from("crm_tasks")
        .select("id")
        .eq("organization_id", org)
        .eq("id", parentTaskId)
        .maybeSingle();
      if (!parent) throw new Error("clickup_parent_task_not_applied");
    }
    await upsertTask(db, {
      id: taskId,
      organization_id: org,
      parent_task_id: parentTaskId,
      title,
      description,
      due_date: dueDate,
      start_at: startAt,
      time_estimate_ms: timeEstimateMs,
      tags,
      priority,
      source_metadata: { clickup: clickupMetadata, clickup_import_run_id: run.id },
      assigned_to: owner,
      status:
        meta.date_done ||
        meta.date_closed ||
        meta.status_type === "closed" ||
        meta.status_type === "done" ||
        (meta.status && typeof meta.status === "object" && (meta.status as Row).type === "closed")
          ? "done"
          : "pending",
    });
    await receipt(db, run, item, "task", externalId, { task_id: taskId });
    return "succeeded" as const;
  }
  if (parentExternalId) {
    const taskId = clickupDeterministicId(org, "clickup-task", externalId);
    const { ancestorExternalId, parentTaskExternalId } = await resolveClickUpTaskAncestry(
      parentExternalId,
      mapping.list_id,
      async (candidateExternalId) => {
        const { data: ancestor, error } = await db
          .from("clickup_import_items")
          .select("parent_external_id")
          .eq("organization_id", org)
          .eq("run_id", run.id)
          .eq("entity_type", "task")
          .eq("external_id", candidateExternalId)
          .maybeSingle();
        if (error) throw new Error(`clickup_parent_lookup_failed:${error.message}`);
        return ancestor
          ? ancestor.parent_external_id
            ? String(ancestor.parent_external_id)
            : null
          : undefined;
      },
    );
    const leadId = clickupDeterministicId(org, "clickup-lead", ancestorExternalId);
    const { data: parentLead } = await db
      .from("crm_leads")
      .select("id")
      .eq("organization_id", org)
      .eq("id", leadId)
      .maybeSingle();
    if (!parentLead) throw new Error("clickup_parent_lead_not_applied");
    const parentTaskId = parentTaskExternalId
      ? clickupDeterministicId(org, "clickup-task", parentTaskExternalId)
      : null;
    if (parentTaskId) {
      const { data: parentTask } = await db
        .from("crm_tasks")
        .select("id")
        .eq("organization_id", org)
        .eq("id", parentTaskId)
        .maybeSingle();
      if (!parentTask) throw new Error("clickup_parent_task_not_applied");
    }
    await upsertTask(db, {
      id: taskId,
      organization_id: org,
      lead_id: leadId,
      parent_task_id: parentTaskId,
      title,
      description,
      due_date: dueDate,
      start_at: startAt,
      time_estimate_ms: timeEstimateMs,
      tags,
      priority,
      source_metadata: { clickup: clickupMetadata, clickup_import_run_id: run.id },
      assigned_to: owner,
    });
    await receipt(db, run, item, "task", externalId, { task_id: taskId });
    return "succeeded" as const;
  }
  const pipelineId = clickupDeterministicId(org, "clickup-pipeline", mapping.pipeline_key!);
  const statusId = String(meta.status_id ?? "");
  const status = mapping.statuses.find((candidate) => candidate.status_id === statusId);
  if (!status) throw new Error(`clickup_status_not_mapped:${statusId || "missing"}`);
  const terminalClosedAt =
    status.terminal === "open"
      ? null
      : normalizeClickUpDueDate(meta.date_closed ?? meta.date_done ?? meta.date_updated);
  if (status.terminal !== "open" && !terminalClosedAt) {
    throw new Error("clickup_terminal_without_close_timestamp");
  }
  const usedUpdatedAtFallback =
    status.terminal !== "open" &&
    !meta.date_closed &&
    !meta.date_done &&
    Boolean(meta.date_updated);
  const customValues = Array.isArray(meta.custom_fields)
    ? Object.fromEntries(
        (meta.custom_fields as Row[]).flatMap((field) => {
          const fieldId = String(field.id ?? "");
          const configured = allMappings
            .filter((candidate) => candidate.pipeline_key === mapping.pipeline_key)
            .flatMap((candidate) => candidate.fields)
            .find((candidate) => candidate.field_id === fieldId && candidate.action !== "ignore");
          return configured
            ? [
                [
                  clickupCustomFieldKey(fieldId),
                  convertClickUpFieldValue(configured.target_type ?? "text", field.value),
                ],
              ]
            : [];
        }),
      )
    : {};
  const leadId = clickupDeterministicId(org, "clickup-lead", externalId);
  await upsertLead(db, {
    id: leadId,
    organization_id: org,
    pipeline_id: pipelineId,
    stage_id: clickupDeterministicId(org, "clickup-stage", mapping.pipeline_key!, status.status_id),
    title,
    description,
    status: status.terminal,
    closed_at: terminalClosedAt,
    lost_reason: status.terminal === "lost" ? "Importado do ClickUp" : null,
    source: "clickup",
    external_id: externalId,
    source_metadata: {
      clickup_import_run_id: run.id,
      clickup_list_id: mapping.list_id,
      clickup: clickupMetadata,
      ...(usedUpdatedAtFallback ? { clickup_closed_at_fallback: "date_updated" } : {}),
      ...(attachmentStatus !== "none"
        ? {
            clickup_attachments: { status: attachmentStatus, count: meta.attachment_count ?? null },
          }
        : {}),
    },
    custom_fields: customValues,
    tags,
    owner_user_id: owner,
  });
  await receipt(db, run, item, "task", externalId, { lead_id: leadId });
  return "succeeded" as const;
}

export async function applyClickUpCrmItem(db: SupabaseClient, run: Row, item: Row) {
  const parsed = clickupCrmMappingConfigSchema.parse((run.mapping_config as Row | null)?.crm);
  if (run.dry_run === true) return "validated" as const;
  if (item.entity_type === "task_relation") return applyClickUpCrmRelation(db, run, item);
  const mapping = listFor(item, parsed.lists);
  if (!mapping) return "skipped" as const;
  if (["list", "task", "status", "custom_field"].includes(String(item.entity_type))) {
    const { data: previous } = await db
      .from("clickup_object_mappings")
      .select("source_hash")
      .eq("organization_id", run.organization_id)
      .eq("workspace_id", run.workspace_id)
      .eq("entity_type", item.entity_type)
      .eq("external_id", item.external_id)
      .maybeSingle();
    if (previous) {
      if (previous.source_hash === item.source_hash) return "unchanged" as const;
      throw new Error("clickup_create_only_source_changed");
    }
  }
  if (item.entity_type === "list") return aplicarLista(db, run, item, mapping, parsed.lists);
  if (item.entity_type === "status" || item.entity_type === "custom_field") {
    return aplicarBinding(db, run, item, mapping, parsed.lists);
  }
  if (item.entity_type === "task") {
    return aplicarTask(db, run, item, mapping, parsed.lists, parsed.multiple_assignees);
  }
  return "skipped" as const;
}
