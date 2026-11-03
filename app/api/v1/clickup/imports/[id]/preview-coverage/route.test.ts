import { describe, expect, it, vi } from "vitest";

const { requireRoleMock, createAdminClientMock } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  createAdminClientMock: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: requireRoleMock }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: createAdminClientMock }));
vi.mock("@/lib/clickup/crm/aplicar", () => ({ loadClickUpMemberDirectory: vi.fn() }));

import { GET } from "./route";

describe("coverage do preview ClickUp", () => {
  it("mantém viewer fora da configuração/importação", async () => {
    requireRoleMock.mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    });
    const response = await GET(new Request("https://deskcomm.test"), {
      params: Promise.resolve({ id: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(response.status).toBe(403);
    expect(requireRoleMock).toHaveBeenCalledWith(
      "manager",
      expect.objectContaining({ resource: "clickup_import_runs" }),
    );
    expect(createAdminClientMock).not.toHaveBeenCalled();
  });
});
