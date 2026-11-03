import { describe, expect, it } from "vitest";

import {
  areaAtiva,
  grupoAtivo,
  gruposPorArea,
  podeRestaurarGrupo,
  posicaoDepoisDeGrupo,
  proximaPosicao,
  type GrupoDeFunil,
} from "./grupos";

const item = (
  id: string,
  kind: "area" | "grupo",
  parent_id: string | null,
  position: number,
): GrupoDeFunil => ({
  id,
  organization_id: "org",
  name: id,
  kind,
  parent_id,
  position,
  archived_at: null,
});

describe("grupos de funil", () => {
  it("monta Área > Grupo e não promove órfão para Área", () => {
    const grupos = [
      item("a", "area", null, 1000),
      item("g", "grupo", "a", 1000),
      item("o", "grupo", "sumiu", 2000),
    ];
    expect(gruposPorArea(grupos)).toEqual([{ area: grupos[0], grupos: [grupos[1]] }]);
  });

  it("arquivado não é destino ativo", () => {
    const area = { ...item("a", "area", null, 1000), archived_at: "2026-11-02T00:00:00Z" };
    const grupo = { ...item("g", "grupo", "a", 1000), archived_at: "2026-11-02T00:00:00Z" };
    expect(areaAtiva([area], "a")).toBeNull();
    expect(grupoAtivo([grupo], "g")).toBeNull();
  });

  it("nova posição respeita apenas os irmãos ativos", () => {
    const grupos = [
      item("a", "area", null, 1000),
      item("g1", "grupo", "a", 1000),
      item("g2", "grupo", "a", 3500),
    ];
    expect(proximaPosicao(grupos, "a")).toBe(4500);
  });

  it("não restaura Grupo enquanto a Área pai estiver arquivada", () => {
    const area = { ...item("a", "area", null, 1000), archived_at: "2026-11-02T00:00:00Z" };
    const grupo = { ...item("g", "grupo", "a", 1000), archived_at: "2026-11-02T00:00:00Z" };
    expect(podeRestaurarGrupo([area, grupo], grupo)).toBe(false);
    expect(podeRestaurarGrupo([area, grupo, item("b", "area", null, 2000)], grupo, "b")).toBe(true);
  });

  it("reordena por vizinho sem aceitar posição crua", () => {
    const area = item("a", "area", null, 1000);
    const primeiro = item("g1", "grupo", "a", 1000);
    const alvo = item("g2", "grupo", "a", 2000);
    const ultimo = item("g3", "grupo", "a", 3000);
    expect(posicaoDepoisDeGrupo([area, primeiro, alvo, ultimo], alvo, "a", "g1")).toEqual({
      ok: true,
      position: 2000,
    });
    expect(posicaoDepoisDeGrupo([area, primeiro, alvo, ultimo], alvo, "a", "fora")).toEqual({
      ok: false,
      motivo: "vizinho_invalido",
    });
  });
});
