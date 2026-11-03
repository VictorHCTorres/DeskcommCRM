import type { SupabaseClient } from "@supabase/supabase-js";

type Entity = { kind: "task" | "lead"; id: string };
type Row = Record<string, unknown>;

export interface ClickUpRelationView {
  id: string;
  relation_type: "linked" | "dependency";
  target: Entity & { title: string };
}

/** Resolve títulos autorizados por RLS e nunca expõe IDs externos/metadata ClickUp. */
export async function listClickUpRelations(
  db: SupabaseClient,
  input: { organizationId: string; entity: Entity },
): Promise<ClickUpRelationView[]> {
  const column = input.entity.kind === "task" ? "task_id" : "lead_id";
  const { data, error } = await db
    .from("crm_clickup_relations")
    .select("id,relation_type,left_lead_id,left_task_id,right_lead_id,right_task_id")
    .eq("organization_id", input.organizationId)
    .or(`left_${column}.eq.${input.entity.id},right_${column}.eq.${input.entity.id}`);
  if (error) throw new Error(`clickup_relations_read:${error.message}`);
  const targets = (data ?? []).map((relation) => {
    const row = relation as Row;
    const isLeft = String(row[`left_${column}`] ?? "") === input.entity.id;
    const side = isLeft ? "right" : "left";
    const leadId = row[`${side}_lead_id`];
    return {
      row,
      target: leadId
        ? ({ kind: "lead", id: String(leadId) } as const)
        : ({ kind: "task", id: String(row[`${side}_task_id`]) } as const),
    };
  });
  const taskIds = [
    ...new Set(targets.filter((item) => item.target.kind === "task").map((item) => item.target.id)),
  ];
  const leadIds = [
    ...new Set(targets.filter((item) => item.target.kind === "lead").map((item) => item.target.id)),
  ];
  const titles = new Map<string, string>();
  if (taskIds.length) {
    const { data: tasks, error: taskError } = await db
      .from("crm_tasks")
      .select("id,title")
      .eq("organization_id", input.organizationId)
      .in("id", taskIds);
    if (taskError) throw new Error(`clickup_relations_tasks:${taskError.message}`);
    for (const task of tasks ?? []) titles.set(`task:${task.id}`, task.title);
  }
  if (leadIds.length) {
    const { data: leads, error: leadError } = await db
      .from("crm_leads")
      .select("id,title")
      .eq("organization_id", input.organizationId)
      .in("id", leadIds);
    if (leadError) throw new Error(`clickup_relations_leads:${leadError.message}`);
    for (const lead of leads ?? []) titles.set(`lead:${lead.id}`, lead.title);
  }
  return targets.flatMap(({ row, target }) => {
    const title = titles.get(`${target.kind}:${target.id}`);
    if (!title) return [];
    return [
      {
        id: String(row.id),
        relation_type: row.relation_type === "dependency" ? "dependency" : "linked",
        target: { ...target, title },
      },
    ];
  });
}
