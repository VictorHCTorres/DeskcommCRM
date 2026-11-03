import { z } from "zod";

import { filtrosForaDaLista } from "@/lib/kanban/filtros-da-lista";
import { filtersToParams, marcadoresDoFiltro, type LeadFilters } from "@/lib/kanban/filters";

export const tipoDeVisaoSchema = z.enum(["quadro", "lista", "calendario"]);
export const visibilidadeDaVisaoSchema = z.enum(["personal", "shared"]);
export const ordenacaoDaListaSchema = z
  .object({
    field: z.enum(["position", "title", "last_activity"]).default("position"),
    direction: z.enum(["asc", "desc"]).default("asc"),
  })
  .strict();
export const configuracaoDoCalendarioSchema = z
  .object({
    mode: z.enum(["month", "week"]).default("month"),
    date_field: z.string().trim().min(1).max(80).nullable().default(null),
    end_date_field: z.string().trim().min(1).max(80).nullable().default(null),
  })
  .strict();

const filtrosSchema = z
  .object({
    owner: z.string().trim().min(1).max(100).optional(),
    status: z.enum(["all", "open", "won", "lost"]).optional(),
    tag: z.union([z.string(), z.array(z.string()).readonly()]).optional(),
    tagMode: z.enum(["e", "ou"]).optional(),
    search: z.string().max(200).optional(),
    overdueOnly: z.boolean().optional(),
    lostReason: z.string().max(200).optional(),
    lostCategory: z.string().max(200).optional(),
  })
  .strict();

export type TipoDeVisaoSalva = z.infer<typeof tipoDeVisaoSchema>;
export type OrdenacaoDaLista = z.infer<typeof ordenacaoDaListaSchema>;
export type ConfiguracaoDoCalendario = z.infer<typeof configuracaoDoCalendarioSchema>;

export interface VisaoSalvaDoFunil {
  id: string;
  organization_id: string;
  pipeline_id: string;
  owner_user_id: string | null;
  created_by: string | null;
  name: string;
  visibility: "personal" | "shared";
  view_type: TipoDeVisaoSalva;
  filters: LeadFilters;
  sort_config: OrdenacaoDaLista;
  view_config: Record<string, unknown>;
  schema_version: 1;
  position: number;
  created_at: string;
  updated_at: string;
}

export function canonicalizarFiltros(filtros: LeadFilters): LeadFilters {
  const tags = marcadoresDoFiltro(filtros.tag).sort((a, b) => a.localeCompare(b));
  return {
    ...(filtros.owner && filtros.owner !== "any" ? { owner: filtros.owner } : {}),
    ...(filtros.status && filtros.status !== "all" ? { status: filtros.status } : {}),
    ...(tags.length ? { tag: tags } : {}),
    ...(tags.length > 1 && filtros.tagMode === "ou" ? { tagMode: "ou" as const } : {}),
    ...(filtros.search?.trim() ? { search: filtros.search.trim() } : {}),
    ...(filtros.overdueOnly ? { overdueOnly: true } : {}),
    ...(filtros.lostReason?.trim() ? { lostReason: filtros.lostReason.trim() } : {}),
    ...(filtros.lostCategory?.trim() ? { lostCategory: filtros.lostCategory.trim() } : {}),
  };
}

export const corpoBaseDaVisaoSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    visibility: visibilidadeDaVisaoSchema.default("personal"),
    view_type: tipoDeVisaoSchema,
    filters: filtrosSchema.default({}),
    sort_config: ordenacaoDaListaSchema.default({ field: "position", direction: "asc" }),
    view_config: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const corpoDaVisaoSchema = corpoBaseDaVisaoSchema.superRefine((valor, ctx) => {
  const filtros = canonicalizarFiltros(valor.filters);
  if (valor.view_type === "lista" && filtrosForaDaLista(filtros).length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["filters"],
      message: "A Lista só salva filtros de responsável e situação.",
    });
  }
  if (valor.view_type === "calendario") {
    const parsed = configuracaoDoCalendarioSchema.safeParse(valor.view_config);
    if (!parsed.success) {
      ctx.addIssue({ code: "custom", path: ["view_config"], message: "Calendário inválido." });
    }
  } else if (Object.keys(valor.view_config).length > 0) {
    ctx.addIssue({
      code: "custom",
      path: ["view_config"],
      message: "Esta visualização não usa configuração adicional.",
    });
  }
});

export type CorpoDaVisao = z.infer<typeof corpoDaVisaoSchema>;

export function canonicalizarCorpoDaVisao(entrada: CorpoDaVisao): CorpoDaVisao {
  return {
    ...entrada,
    name: entrada.name.trim(),
    filters: canonicalizarFiltros(entrada.filters),
    sort_config:
      entrada.view_type === "lista"
        ? ordenacaoDaListaSchema.parse(entrada.sort_config)
        : { field: "position", direction: "asc" },
    view_config:
      entrada.view_type === "calendario"
        ? configuracaoDoCalendarioSchema.parse(entrada.view_config)
        : {},
  };
}

const PARAMETROS_CONTROLADOS_PELA_VISAO = [
  "owner",
  "status",
  "tag",
  "modo",
  "q",
  "overdue",
  "motivo",
  "categoria",
  "visao",
  "view",
] as const;

export function paramsDaVisao(
  visao: VisaoSalvaDoFunil,
  atuais?: { toString(): string },
): URLSearchParams {
  const params = new URLSearchParams(atuais?.toString());
  for (const chave of PARAMETROS_CONTROLADOS_PELA_VISAO) params.delete(chave);
  const filtros = new URLSearchParams(filtersToParams(visao.filters));
  for (const [chave, valor] of filtros) params.append(chave, valor);
  if (visao.view_type !== "quadro") params.set("visao", visao.view_type);
  params.set("view", visao.id);
  return params;
}

export function assinaturaDaVisao(entrada: {
  view_type: TipoDeVisaoSalva;
  filters: LeadFilters;
  sort_config: OrdenacaoDaLista;
  view_config: Record<string, unknown>;
}): string {
  return JSON.stringify({
    view_type: entrada.view_type,
    filters: canonicalizarFiltros(entrada.filters),
    sort_config:
      entrada.view_type === "lista"
        ? ordenacaoDaListaSchema.parse(entrada.sort_config)
        : { field: "position", direction: "asc" },
    view_config:
      entrada.view_type === "calendario"
        ? configuracaoDoCalendarioSchema.parse(entrada.view_config)
        : {},
  });
}
