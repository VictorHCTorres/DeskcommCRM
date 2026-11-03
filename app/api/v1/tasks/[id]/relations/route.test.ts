import { describe, expect, it, vi } from "vitest";

const { requireRoleMock, createClientMock } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: requireRoleMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

import { GET } from "./route";

describe("relações ClickUp da tarefa", () => {
  it("é read-only para viewer autenticado e não abre acesso sem papel", async () => {
    requireRoleMock.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const response = await GET(new Request("https://deskcomm.test"), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(response.status).toBe(403);
    expect(requireRoleMock).toHaveBeenCalledWith(
      "viewer",
      expect.objectContaining({ resource: "crm_clickup_relations" }),
    );
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
