import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SeletorDeVisoes } from "./SeletorDeVisoes";

const h = vi.hoisted(() => ({
  views: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/pipelines/usePipelineViews", () => ({
  usePipelineViews: () => ({ data: { data: h.views } }),
  useCreatePipelineView: () => ({ mutateAsync: h.create, isPending: false }),
  useUpdatePipelineView: () => ({ mutateAsync: h.update, isPending: false }),
  useDeletePipelineView: () => ({ mutateAsync: h.remove, isPending: false }),
}));

const view = {
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "org",
  pipeline_id: "pipe",
  owner_user_id: "user",
  created_by: "user",
  name: "Minha carteira",
  visibility: "personal",
  view_type: "quadro",
  filters: {},
  sort_config: { field: "position", direction: "asc" },
  view_config: {},
  schema_version: 1,
  position: 1000,
  created_at: "2026-11-02T00:00:00Z",
  updated_at: "2026-11-02T00:00:00Z",
};

describe("SeletorDeVisoes", () => {
  beforeEach(() => {
    h.views = [];
    h.create.mockReset().mockResolvedValue({ data: view });
    h.update.mockReset().mockResolvedValue({ data: view });
    h.remove.mockReset().mockResolvedValue({ data: { deleted: true } });
  });

  it("mostra estado Modificada e oferece atualizar/excluir a visão pessoal", () => {
    h.views = [view];
    render(
      <SeletorDeVisoes
        pipelineId="pipe"
        activeViewId={view.id}
        modified
        current={{
          view_type: "quadro",
          filters: {},
          sort_config: { field: "position", direction: "asc" },
          view_config: {},
        }}
        canManageShared={false}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Modificada");
    expect(screen.getByRole("button", { name: "Atualizar" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Excluir" })).toBeEnabled();
  });

  it("avisa quando o id pedido na URL não é acessível", async () => {
    h.views = [];
    const onUnavailable = vi.fn();
    render(
      <SeletorDeVisoes
        pipelineId="pipe"
        activeViewId={null}
        requestedViewId="00000000-0000-4000-8000-000000000099"
        modified={false}
        current={{
          view_type: "quadro",
          filters: {},
          sort_config: { field: "position", direction: "asc" },
          view_config: {},
        }}
        canManageShared={false}
        onApply={vi.fn()}
        onUnavailable={onUnavailable}
      />,
    );
    await waitFor(() => expect(onUnavailable).toHaveBeenCalledOnce());
  });

  it("salva como uma visualização pessoal e aplica a resposta canônica", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <SeletorDeVisoes
        pipelineId="pipe"
        activeViewId={null}
        modified={false}
        current={{
          view_type: "quadro",
          filters: { status: "open" },
          sort_config: { field: "position", direction: "asc" },
          view_config: {},
        }}
        canManageShared={false}
        onApply={onApply}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Salvar como" }));
    await user.type(
      screen.getByRole("textbox", { name: "Nome da visualização" }),
      "Minha carteira",
    );
    await user.click(screen.getByRole("button", { name: /^Salvar$/ }));

    await waitFor(() =>
      expect(h.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Minha carteira",
          visibility: "personal",
          view_type: "quadro",
          filters: { status: "open" },
        }),
      ),
    );
    expect(onApply).toHaveBeenCalledWith(view);
  });

  it("atualiza e exclui a visualização pessoal ativa", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    h.views = [view];
    render(
      <SeletorDeVisoes
        pipelineId="pipe"
        activeViewId={view.id}
        modified
        current={{
          view_type: "quadro",
          filters: { status: "open" },
          sort_config: { field: "position", direction: "asc" },
          view_config: {},
        }}
        canManageShared={false}
        onApply={onApply}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Atualizar" }));
    await waitFor(() =>
      expect(h.update).toHaveBeenCalledWith({
        id: view.id,
        body: expect.objectContaining({ filters: { status: "open" } }),
      }),
    );
    expect(onApply).toHaveBeenCalledWith(view);

    await user.click(screen.getByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(h.remove).toHaveBeenCalledWith(view.id));
    expect(onApply).toHaveBeenLastCalledWith(null);
  });
});
