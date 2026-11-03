import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { clickupRunIdSchema } from "@/lib/clickup/contrato";
import { getClickUpImportPage } from "@/lib/clickup/store";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure } from "../../_shared";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const querySchema = z.object({
  after: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  entity_types: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(z.enum(["list", "status", "custom_field"])).max(3))
    .optional(),
});

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "clickup_import_runs",
    allowPlatformAdmin: "leitura",
  });
  if (!authz.ok) return authz.response;
  const runId = clickupRunIdSchema.safeParse((await context.params).id);
  const url = new URL(request.url);
  const query = querySchema.safeParse({
    after: url.searchParams.get("after") ?? undefined,
    limit: url.searchParams.get("limit") ?? undefined,
    entity_types: url.searchParams.get("entity_types") ?? undefined,
  });
  if (!runId.success || !query.success) {
    return fail("validation_failed", "Consulta da importação inválida.", 422, { requestId });
  }
  try {
    const page = await getClickUpImportPage(createAdminClient(), {
      organizationId: authz.org.orgId,
      runId: runId.data,
      afterId: query.data.after,
      limit: query.data.limit,
      entityTypes: query.data.entity_types,
    });
    return ok(
      { run: page.run, items: page.items, summary: page.summary },
      {
        requestId,
        meta: { cursor: page.cursor, has_more: page.hasMore },
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    return clickupFailure(error, requestId);
  }
}
