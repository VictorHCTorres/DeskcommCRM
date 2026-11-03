import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { CLICKUP_ENVELOPE_SCHEMA_VERSION, clickupDiscoverySchema } from "@/lib/clickup/contrato";
import { decryptClickUpToken } from "@/lib/clickup/crypto";
import { canonicalizeClickUpManifest, manifestHash } from "@/lib/clickup/manifest";
import { loadClickUpConnectionSecret } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../_shared";

const clickupSpacesResponseSchema = z.object({
  spaces: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string(),
      private: z.boolean().optional(),
      archived: z.boolean().optional(),
    }),
  ),
});

export async function POST(request: Request): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "clickup_import_runs",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const body = clickupDiscoverySchema.safeParse(await readJson(request));
  if (!body.success) {
    return fail("validation_failed", "Pedido de descoberta inválido.", 422, { requestId });
  }
  try {
    const connection = await loadClickUpConnectionSecret(
      createAdminClient(),
      authz.org.orgId,
      body.data.connection_id,
    );
    const token = decryptClickUpToken(connection);
    const response = await fetch(
      `https://api.clickup.com/api/v2/team/${encodeURIComponent(connection.workspace_id)}/space?archived=false`,
      {
        method: "GET",
        headers: { Authorization: token, Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) {
      console.warn("[clickup-discovery] provider rejected request", {
        requestId,
        status: response.status,
      });
      return fail("upstream_error", "O ClickUp não permitiu consultar este workspace.", 502, {
        requestId,
      });
    }
    const parsed = clickupSpacesResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      return fail("upstream_error", "O ClickUp devolveu uma resposta incompatível.", 502, {
        requestId,
      });
    }
    const manifest = canonicalizeClickUpManifest({
      connection_id: connection.id,
      workspace_id: connection.workspace_id,
      source: "api",
      scope: "crm",
      manifest_version: CLICKUP_ENVELOPE_SCHEMA_VERSION,
      objects: parsed.data.spaces.map((space) => ({
        source_type: "space" as const,
        source_id: space.id,
        metadata: {
          name: space.name,
          private: space.private ?? false,
          archived: space.archived ?? false,
        },
        content_access: "none" as const,
      })),
    });
    return ok({ manifest, snapshot_hash: manifestHash(manifest) }, { requestId });
  } catch (error) {
    return clickupFailure(error, requestId);
  }
}
