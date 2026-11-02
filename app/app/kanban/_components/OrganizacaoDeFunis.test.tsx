import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GrupoDeFunil } from "@/lib/pipelines/grupos";
import { OrganizacaoDeFunis } from "./OrganizacaoDeFunis";

const h = vi.hoisted(() => ({ mutate: vi.fn(), pending: false }));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/pipelines/usePipelineGroups", () => ({
  useCriarGrupoDeFunil: () => ({ mutate: vi.fn(), isPending: h.pending }),
  useEditarGrupoDeFunil: () => ({ mutate: h.mutate, isPending: h.pending }),
}));

const item = (
  id: string,
  name: string,
  kind: "area" | "grupo",
  parent_id: string | null,
  position: number,
  archived_at: string | null = null,
): GrupoDeFunil => ({ id, organization_id: "org", name, kind, parent_id, position, archived_at });

describe("OrganizacaoDeFunis", () => {
  beforeEach(() => h.mutate.mockClear());

  it("expõe arquivamento, restauração e ordenação com nomes acessíveis", () => {
    render(
      <OrganizacaoDeFunis
        grupos={[
          item("a1", "Comercial", "area", null, 1000),
          item("a2", "Pós-venda", "area", null, 2000),
          item("g1", "Prospecção", "grupo", "a1", 1000),
          item("g2", "Qualificação", "grupo", "a1", 2000),
          item("ga", "Legado", "grupo", "a1", 3000, "2026-11-02T00:00:00Z"),
        ]}
        onChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Mover grupo para baixo: Prospecção" }));
    expect(h.mutate).toHaveBeenLastCalledWith(
      { id: "g1", patch: { depois_de: "g2" } },
      expect.any(Object),
    );

    fireEvent.click(screen.getByText(/Áreas e grupos arquivados/));
    fireEvent.click(screen.getByRole("button", { name: "Restaurar Grupo: Legado" }));
    expect(h.mutate).toHaveBeenLastCalledWith(
      { id: "ga", patch: { archived: false, parent_id: "a1" } },
      expect.any(Object),
    );
  });

  it("anuncia erro de mutação como alerta", () => {
    h.mutate.mockImplementationOnce((_pedido, opcoes) => opcoes.onError(new Error("Falhou")));
    render(
      <OrganizacaoDeFunis
        grupos={[item("a1", "Comercial", "area", null, 1000)]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Arquivar área" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Falhou");
  });
});
