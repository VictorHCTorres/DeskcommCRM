import { fail } from "@/lib/api/wrappers";
import { ClickUpStoreError } from "@/lib/clickup/store";

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function clickupFailure(error: unknown, requestId: string): Response {
  if (error instanceof ClickUpStoreError) {
    if (error.code === "not_found") return fail("not_found", error.message, 404, { requestId });
    if (error.code === "conflict" || error.code === "invalid_state") {
      return fail("state_conflict", error.message, 409, { requestId });
    }
  }
  console.error("[clickup-import] operation failed", {
    requestId,
    kind: error instanceof Error ? error.name : "unknown",
  });
  return fail("internal_error", "Não foi possível concluir a operação do ClickUp.", 500, {
    requestId,
  });
}
