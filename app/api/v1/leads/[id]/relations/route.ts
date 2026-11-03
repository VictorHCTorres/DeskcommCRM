import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { listClickUpRelations } from "@/lib/clickup/presentation/relations";
import { createClient } from "@/lib/supabase/server";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "crm_clickup_relations" });
  if (!authz.ok) return authz.response;
  const id = z
    .string()
    .uuid()
    .safeParse((await context.params).id);
  if (!id.success) return fail("validation_failed", "Negócio inválido.", 422, { requestId });
  try {
    const relations = await listClickUpRelations(
      (await createClient()) as unknown as SupabaseClient,
      {
        organizationId: authz.org.orgId,
        entity: { kind: "lead", id: id.data },
      },
    );
    return ok(
      { relations, read_only: true },
      { requestId, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return fail("internal_error", "Erro ao carregar relações.", 500, { requestId });
  }
}
