import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import {
  chaveDaRequisicao,
  comIdempotencia,
  JANELA_LONGA_DA_RESERVA_MS,
} from "@/lib/api/idempotency";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { escreveComoPlatformAdmin } from "@/lib/auth/types";
import { clickupRunIdSchema } from "@/lib/clickup/contrato";
import {
  assertCompleteClickUpFullCoverage,
  resolveClickUpSidecarBlobReceipts,
} from "@/lib/clickup/assets/staging";
import { clickupSidecarSchema } from "@/lib/clickup/sidecar-contrato";
import { loadClickUpAssetUpload, stageClickUpAssetSidecar } from "@/lib/clickup/store";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

import { clickupFailure, readJson } from "../../../../_shared";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const bodySchema = z
  .object({
    upload_id: z.string().uuid(),
    blob_receipts: z
      .array(
        z
          .object({
            attachment_id: z.string().trim().min(1).max(512),
            blob_ref: z.string().trim().min(1).max(1_024),
            upload_id: z.string().uuid(),
          })
          .strict(),
      )
      .max(50_000)
      .default([]),
  })
  .strict();

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const denied = await requireSupportWrite();
  if (denied) return denied;
  const requestId = randomUUID();
  const authz = await requireRole("manager", {
    requestId,
    resource: "clickup_import_runs",
    allowPlatformAdmin: true,
  });
  if (!authz.ok) return authz.response;
  const runId = clickupRunIdSchema.safeParse((await context.params).id);
  const body = bodySchema.safeParse(await readJson(request));
  const idempotencyKey = chaveDaRequisicao(request);
  if (
    !runId.success ||
    !body.success ||
    !idempotencyKey ||
    !clickupRunIdSchema.safeParse(idempotencyKey).success
  ) {
    return fail("validation_failed", "Staging de sidecar inválido.", 422, { requestId });
  }
  try {
    const db = createAdminClient();
    const outcome = await comIdempotencia({
      db,
      organizationId: authz.org.orgId,
      endpoint: `clickup.imports.${runId.data}.assets.stage`,
      chave: idempotencyKey,
      corpo: body.data,
      reservaMs: JANELA_LONGA_DA_RESERVA_MS,
      executar: async () => {
        const upload = await loadClickUpAssetUpload(db, {
          organizationId: authz.org.orgId,
          userId: authz.user.id,
          runId: runId.data,
          uploadId: body.data.upload_id,
          kind: "sidecar",
        });
        const storage = db.storage.from("clickup-sidecars");
        const { data: blob, error } = await storage.download(String(upload.storage_path));
        if (error || !blob || blob.size !== Number(upload.declared_size)) {
          throw new Error("clickup_sidecar_upload_missing_or_size_mismatch");
        }
        const bytes = new Uint8Array(await blob.arrayBuffer());
        if (createHash("sha256").update(bytes).digest("hex") !== upload.sha256) {
          throw new Error("clickup_sidecar_sha256_mismatch");
        }
        let raw: unknown;
        try {
          raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        } catch {
          throw new Error("clickup_sidecar_invalid_json");
        }
        const sidecar = clickupSidecarSchema.parse(raw);
        const { data: stagedTasks, error: tasksError } = await db
          .from("clickup_import_items")
          .select("external_id,entity_type,source_metadata")
          .eq("organization_id", authz.org.orgId)
          .eq("run_id", runId.data)
          .in("entity_type", ["task", "doc"]);
        if (tasksError) throw new Error("clickup_sidecar_tasks_unavailable");
        const taskIds = (stagedTasks ?? [])
          .filter((item) => item.entity_type === "task")
          .map((task) => String(task.external_id));
        const docPageIds = (stagedTasks ?? []).flatMap((item) => {
          if (item.entity_type !== "doc") return [];
          const pageIds = (item.source_metadata as { page_ids?: unknown } | null)?.page_ids;
          return Array.isArray(pageIds) ? pageIds.map(String) : [];
        });
        assertCompleteClickUpFullCoverage(sidecar, taskIds, docPageIds);
        const stagedSidecar = resolveClickUpSidecarBlobReceipts(sidecar, body.data.blob_receipts);
        if (
          sidecar.assets.some((asset) => asset.parent_type === "doc_page") &&
          authz.org.role !== "admin" &&
          !escreveComoPlatformAdmin(authz.user)
        ) {
          throw new Error("clickup_docs_asset_admin_consent_required");
        }
        const sidecarId = await stageClickUpAssetSidecar(db, {
          organizationId: authz.org.orgId,
          userId: authz.user.id,
          runId: runId.data,
          sidecar: stagedSidecar,
        });
        const { error: consumeError } = await db
          .from("clickup_asset_uploads")
          .update({ state: "consumed" })
          .eq("organization_id", authz.org.orgId)
          .eq("id", upload.id);
        if (consumeError) throw new Error("clickup_sidecar_upload_consume_failed");
        const { data: queued, error: queueError } = await db.rpc(
          "fn_queue_clickup_quarantine_cleanup",
          { p_organization_id: authz.org.orgId, p_upload_id: upload.id },
        );
        if (queueError || queued !== true) {
          throw new Error("clickup_sidecar_quarantine_cleanup_not_queued");
        }
        await storage.remove([String(upload.storage_path)]);
        return { resposta: { sidecar_id: sidecarId }, status: 201 };
      },
    });
    if (outcome.tipo === "conflito")
      return fail("idempotency_conflict", "Chave já usada.", 409, { requestId });
    if (outcome.tipo === "em_curso")
      return fail("idempotency_in_progress", "Sidecar em processamento.", 409, { requestId });
    if (outcome.tipo === "executou") {
      const sidecarId = outcome.resposta.sidecar_id;
      void audit({
        action: "clickup.assets_staged",
        actorUserId: authz.user.id,
        organizationId: authz.org.orgId,
        resourceType: "clickup_asset_sidecar",
        resourceId: sidecarId,
        requestId,
        bypassedRls: true,
        metadata: { run_id: runId.data },
      });
    }
    return ok(outcome.resposta, {
      status: 201,
      requestId,
      headers: outcome.tipo === "replay" ? { "Idempotency-Replayed": "true" } : undefined,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "clickup_docs_asset_admin_consent_required") {
      return fail(
        "forbidden",
        "Assets de Docs privados exigem consentimento administrativo.",
        403,
        {
          requestId,
        },
      );
    }
    if (error instanceof Error && error.message.startsWith("clickup_asset_upload_receipt_")) {
      return fail(
        "validation_failed",
        "Cada blob do sidecar full precisa do upload_id privado preparado pelo servidor.",
        422,
        { requestId },
      );
    }
    if (error instanceof Error && error.message === "clickup_sidecar_incomplete_coverage") {
      return fail(
        "validation_failed",
        "O sidecar full não comprova a varredura de todas as Tasks do snapshot.",
        422,
        { requestId },
      );
    }
    if (error instanceof z.ZodError) {
      return fail("validation_failed", "Sidecar ClickUp inválido.", 422, { requestId });
    }
    return clickupFailure(error, requestId);
  }
}
