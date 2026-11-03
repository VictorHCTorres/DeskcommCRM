"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { CorpoDaVisao, VisaoSalvaDoFunil } from "@/lib/kanban/visoes-salvas";

const chave = (pipelineId: string) => ["pipeline-views", pipelineId] as const;
const rota = (pipelineId: string) => `/api/v1/pipelines/${encodeURIComponent(pipelineId)}/views`;

export function usePipelineViews(pipelineId: string) {
  return useQuery({
    queryKey: chave(pipelineId),
    queryFn: () => apiClient.get<{ data: VisaoSalvaDoFunil[] }>(rota(pipelineId)),
  });
}

export function useCreatePipelineView(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CorpoDaVisao) =>
      apiClient.post<{ data: VisaoSalvaDoFunil }>(rota(pipelineId), body),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: chave(pipelineId) }),
  });
}

export function useUpdatePipelineView(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CorpoDaVisao> }) =>
      apiClient.patch<{ data: VisaoSalvaDoFunil }>(
        `${rota(pipelineId)}/${encodeURIComponent(id)}`,
        body,
      ),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: chave(pipelineId) }),
  });
}

export function useDeletePipelineView(pipelineId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`${rota(pipelineId)}/${encodeURIComponent(id)}`),
    onError: showApiError,
    onSuccess: () => qc.invalidateQueries({ queryKey: chave(pipelineId) }),
  });
}
