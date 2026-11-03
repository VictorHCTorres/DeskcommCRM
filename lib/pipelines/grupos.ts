import type { SupabaseClient } from "@supabase/supabase-js";
import { midpoint } from "@/lib/kanban/fractional-indexing";

export type TipoDeGrupoDeFunil = "area" | "grupo";

export interface GrupoDeFunil {
  id: string;
  organization_id: string;
  name: string;
  kind: TipoDeGrupoDeFunil;
  parent_id: string | null;
  position: number;
  archived_at: string | null;
}

const COLUNAS = "id, organization_id, name, kind, parent_id, position, archived_at";

/** Leitura tenant-safe compartilhada pela API e pelas Server Components. */
export async function listarGruposDeFunil(
  db: SupabaseClient,
  organizationId: string,
  incluiArquivados = false,
): Promise<GrupoDeFunil[]> {
  let query = db
    .from("crm_pipeline_groups")
    .select(COLUNAS)
    .eq("organization_id", organizationId)
    .order("position", { ascending: true });
  if (!incluiArquivados) query = query.is("archived_at", null);
  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as GrupoDeFunil[];
}

export function areaAtiva(
  grupos: GrupoDeFunil[],
  areaId: string | null | undefined,
): GrupoDeFunil | null {
  if (!areaId) return null;
  return (
    grupos.find((grupo) => grupo.id === areaId && grupo.kind === "area" && !grupo.archived_at) ??
    null
  );
}

export function grupoAtivo(
  grupos: GrupoDeFunil[],
  grupoId: string | null | undefined,
): GrupoDeFunil | null {
  if (!grupoId) return null;
  return (
    grupos.find((grupo) => grupo.id === grupoId && grupo.kind === "grupo" && !grupo.archived_at) ??
    null
  );
}

export function proximaPosicao(grupos: GrupoDeFunil[], parentId: string | null): number {
  const irmaos = grupos.filter((grupo) => grupo.parent_id === parentId && !grupo.archived_at);
  return Math.max(0, ...irmaos.map((grupo) => Number(grupo.position))) + 1000;
}

/**
 * Áreas e grupos são configuração do núcleo: o CRM continua útil sem nenhuma
 * linha, e nesse estado todo funil aparece em "Sem grupo".
 */
export function gruposPorArea(grupos: GrupoDeFunil[]) {
  const areas = grupos.filter((grupo) => grupo.kind === "area" && !grupo.archived_at);
  return areas.map((area) => ({
    area,
    grupos: grupos.filter(
      (grupo) => grupo.kind === "grupo" && grupo.parent_id === area.id && !grupo.archived_at,
    ),
  }));
}

export function podeRestaurarGrupo(
  grupos: GrupoDeFunil[],
  alvo: GrupoDeFunil,
  novaAreaId?: string,
): boolean {
  return alvo.kind === "area" || areaAtiva(grupos, novaAreaId ?? alvo.parent_id) !== null;
}

export function posicaoDepoisDeGrupo(
  grupos: GrupoDeFunil[],
  alvo: GrupoDeFunil,
  parentId: string | null,
  depoisDe: string | null,
): { ok: true; position: number } | { ok: false; motivo: "vizinho_invalido" | "empate" } {
  const irmaos = grupos
    .filter(
      (grupo) =>
        grupo.id !== alvo.id &&
        grupo.kind === alvo.kind &&
        grupo.parent_id === parentId &&
        grupo.archived_at === null,
    )
    .sort((a, b) => Number(a.position) - Number(b.position));
  const indice = depoisDe === null ? -1 : irmaos.findIndex((grupo) => grupo.id === depoisDe);
  if (depoisDe !== null && indice < 0) return { ok: false, motivo: "vizinho_invalido" };
  const position = midpoint(irmaos[indice]?.position ?? null, irmaos[indice + 1]?.position ?? null);
  if (!Number.isFinite(position)) return { ok: false, motivo: "empate" };
  return { ok: true, position };
}
