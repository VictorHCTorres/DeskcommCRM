"use client";

import { useMutation } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

import { apiClient } from "@/lib/api/client";
import type { GrupoDeFunil, TipoDeGrupoDeFunil } from "@/lib/pipelines/grupos";

const ROTA = "/api/v1/pipeline-groups";
type Resposta = { data: GrupoDeFunil[] };

function useReler() {
  const router = useRouter();
  return () => router.refresh();
}

export function useCriarGrupoDeFunil() {
  const reler = useReler();
  return useMutation({
    mutationFn: (body: { name: string; kind: TipoDeGrupoDeFunil; parent_id?: string | null }) =>
      apiClient.post<Resposta>(ROTA, body),
    onSettled: reler,
  });
}

export function useEditarGrupoDeFunil() {
  const reler = useReler();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      apiClient.patch<Resposta>(`${ROTA}/${encodeURIComponent(id)}`, patch),
    onSettled: reler,
  });
}
