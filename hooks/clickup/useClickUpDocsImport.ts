"use client";

import { useMutation } from "@tanstack/react-query";
import { randomId } from "@/lib/random-id";

interface PreviewClickUpDocs {
  id: string;
  preview_revision: number;
  snapshot_hash: string;
  mapping_hash: string | null;
  total_items: number;
  applicable_items: number;
  warnings_count: number;
  privacy_warning?: string;
}

async function resposta<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data?: T; error?: { message?: string } };
  if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Falha ao importar Docs.");
  return body.data;
}

export function useClickUpDocsPreview() {
  return useMutation({
    mutationFn: async (manifest: unknown) =>
      resposta<PreviewClickUpDocs>(
        await fetch("/api/v1/clickup/imports/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": randomId() },
          body: JSON.stringify(manifest),
        }),
      ),
  });
}

export function useClickUpDocsExecute() {
  return useMutation({
    mutationFn: async (preview: PreviewClickUpDocs) =>
      resposta<{ id: string; status: string }>(
        await fetch(`/api/v1/clickup/imports/${preview.id}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": randomId() },
          body: JSON.stringify({
            dry_run: false,
            expected_preview_revision: preview.preview_revision,
            expected_snapshot_hash: preview.snapshot_hash,
            expected_mapping_hash: preview.mapping_hash,
          }),
        }),
      ),
  });
}

export type { PreviewClickUpDocs };
