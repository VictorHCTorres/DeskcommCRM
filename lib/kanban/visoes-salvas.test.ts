import { describe, expect, it } from "vitest";

import {
  assinaturaDaVisao,
  canonicalizarCorpoDaVisao,
  corpoDaVisaoSchema,
  paramsDaVisao,
  type VisaoSalvaDoFunil,
} from "./visoes-salvas";

describe("visualizações salvas do funil", () => {
  it("canonicaliza filtros e não persiste âncora temporal ou estado efêmero", () => {
    const parsed = corpoDaVisaoSchema.parse({
      name: "  Minha agenda  ",
      visibility: "personal",
      view_type: "calendario",
      filters: { owner: "any", status: "all" },
      sort_config: {},
      view_config: { mode: "week", date_field: "embarque", end_date_field: null },
    });
    expect(canonicalizarCorpoDaVisao(parsed)).toEqual({
      name: "Minha agenda",
      visibility: "personal",
      view_type: "calendario",
      filters: {},
      sort_config: { field: "position", direction: "asc" },
      view_config: { mode: "week", date_field: "embarque", end_date_field: null },
    });
  });

  it("recusa salvar Lista quando há filtro não suportado", () => {
    expect(
      corpoDaVisaoSchema.safeParse({
        name: "Busca",
        view_type: "lista",
        filters: { search: "Acme" },
      }).success,
    ).toBe(false);
  });

  it("gera URL estável com view, visão e filtros", () => {
    const visao = {
      id: "00000000-0000-4000-8000-000000000001",
      view_type: "lista",
      filters: { owner: "unassigned", status: "open" },
    } as VisaoSalvaDoFunil;
    expect(paramsDaVisao(visao).toString()).toBe(
      "owner=unassigned&status=open&visao=lista&view=00000000-0000-4000-8000-000000000001",
    );
  });

  it("troca só os parâmetros controlados pela visão e preserva o contexto externo", () => {
    const visao = {
      id: "00000000-0000-4000-8000-000000000001",
      view_type: "lista",
      filters: { owner: "unassigned", status: "open" },
    } as VisaoSalvaDoFunil;
    const atuais = new URLSearchParams(
      "lead=lead-1&origem=inbox&q=velha&tag=vip&tag=frio&motivo=sem-verba&visao=calendario&view=antiga",
    );

    const params = paramsDaVisao(visao, atuais);

    expect(params.get("lead")).toBe("lead-1");
    expect(params.get("origem")).toBe("inbox");
    expect(params.get("q")).toBeNull();
    expect(params.getAll("tag")).toEqual([]);
    expect(params.get("motivo")).toBeNull();
    expect(params.get("owner")).toBe("unassigned");
    expect(params.get("status")).toBe("open");
    expect(params.get("view")).toBe(visao.id);
  });

  it("assinatura ignora sort fora da Lista", () => {
    const base = {
      view_type: "quadro" as const,
      filters: {},
      view_config: {},
    };
    expect(assinaturaDaVisao({ ...base, sort_config: { field: "title", direction: "desc" } })).toBe(
      assinaturaDaVisao({ ...base, sort_config: { field: "position", direction: "asc" } }),
    );
  });
});
