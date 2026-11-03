import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

type Row = Record<string, unknown>;

function deterministicId(...parts: string[]): string {
  const hex = createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function endpoint(mapping: Row, side: "left" | "right") {
  if (mapping.lead_id) return { [`${side}_lead_id`]: mapping.lead_id };
  if (mapping.task_id) return { [`${side}_task_id`]: mapping.task_id };
  throw new Error("clickup_relation_parent_not_mapped");
}

/** Materializa um vínculo somente quando os dois receipts tenant-safe existem. */
export async function applyClickUpCrmRelation(
  db: SupabaseClient,
  run: Row,
  item: Row,
): Promise<"succeeded" | "unchanged" | "skipped"> {
  const metadata = (item.source_metadata ?? {}) as Row;
  const relationType = String(metadata.relation_type ?? "");
  const sourceTaskId = String(metadata.source_task_id ?? "");
  const targetTaskId = String(metadata.target_task_id ?? "");
  if (!["linked", "dependency"].includes(relationType) || !sourceTaskId || !targetTaskId) {
    throw new Error("clickup_relation_invalid");
  }
  const organizationId = String(run.organization_id);
  const workspaceId = String(run.workspace_id);
  const { data: parents, error: parentsError } = await db
    .from("clickup_import_items")
    .select("external_id, status, result_kind")
    .eq("organization_id", organizationId)
    .eq("run_id", run.id)
    .eq("entity_type", "task")
    .in("external_id", [sourceTaskId, targetTaskId]);
  if (parentsError) throw new Error(`clickup_relation_parent_lookup:${parentsError.message}`);
  if (
    (parents ?? []).some(
      (parent) => parent.status === "skipped" && parent.result_kind !== "unchanged",
    )
  ) {
    return "skipped";
  }
  if (
    (parents ?? []).length !== 2 ||
    (parents ?? []).some(
      (parent) =>
        !(
          parent.status === "succeeded" ||
          (parent.status === "skipped" && parent.result_kind === "unchanged")
        ) ||
        parent.result_kind === "conflict",
    )
  ) {
    throw new Error("clickup_relation_parent_failed");
  }
  const { data, error } = await db
    .from("clickup_object_mappings")
    .select("external_id, lead_id, task_id")
    .eq("organization_id", organizationId)
    .eq("workspace_id", workspaceId)
    .eq("entity_type", "task")
    .in("external_id", [sourceTaskId, targetTaskId]);
  if (error) throw new Error(`clickup_relation_mapping_lookup:${error.message}`);
  const byExternalId = new Map((data ?? []).map((row) => [String(row.external_id), row as Row]));
  const left = byExternalId.get(sourceTaskId);
  const right = byExternalId.get(targetTaskId);
  if (!left || !right) {
    throw new Error("clickup_relation_parent_not_mapped");
  }

  const relationId = deterministicId(
    organizationId,
    "clickup-relation",
    workspaceId,
    String(item.external_id),
  );
  const { data: existing, error: existingError } = await db
    .from("crm_clickup_relations")
    .select("source_hash")
    .eq("organization_id", organizationId)
    .eq("id", relationId)
    .maybeSingle();
  if (existingError) throw new Error(`clickup_relation_lookup:${existingError.message}`);
  if (existing) {
    if (existing.source_hash === item.source_hash) return "unchanged";
    throw new Error("clickup_create_only_source_changed");
  }
  const { error: insertError } = await db.from("crm_clickup_relations").insert({
    id: relationId,
    organization_id: organizationId,
    workspace_id: workspaceId,
    relation_type: relationType,
    source_external_id: sourceTaskId,
    target_external_id: targetTaskId,
    source_hash: item.source_hash,
    source_revision: item.source_revision ?? null,
    ...endpoint(left, "left"),
    ...endpoint(right, "right"),
  });
  if (insertError?.code === "23505") {
    const { data: replay } = await db
      .from("crm_clickup_relations")
      .select("source_hash")
      .eq("organization_id", organizationId)
      .eq("id", relationId)
      .maybeSingle();
    if (replay?.source_hash === item.source_hash) return "unchanged";
  }
  if (insertError) throw new Error(`clickup_relation_insert:${insertError.message}`);
  return "succeeded";
}
