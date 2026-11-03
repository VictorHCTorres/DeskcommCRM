import { beforeEach, describe, expect, it, vi } from "vitest";

const { requireRoleMock, createClientMock } = vi.hoisted(() => ({
  requireRoleMock: vi.fn(),
  createClientMock: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: requireRoleMock }));
vi.mock("@/lib/supabase/server", () => ({ createClient: createClientMock }));

import { GET } from "./route";

describe("GET comentários históricos da Task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireRoleMock.mockResolvedValue({
      ok: true,
      org: { orgId: "org-a" },
      user: { id: "user" },
    });
  });

  it("escopa Task e comentários pela organização da sessão e responde read-only", async () => {
    const taskEq = vi.fn();
    const taskBuilder = {
      select: vi.fn(() => taskBuilder),
      eq: taskEq.mockImplementation(() => taskBuilder),
      maybeSingle: vi.fn(async () => ({ data: { id: "task-a" }, error: null })),
    };
    const commentsEq = vi.fn();
    const commentsBuilder = {
      select: vi.fn(() => commentsBuilder),
      eq: commentsEq.mockImplementation(() => commentsBuilder),
      order: vi.fn(() => commentsBuilder),
      limit: vi.fn(async () => ({
        data: [{ id: "comment-a", body_markdown: "Histórico" }],
        error: null,
      })),
    };
    const from = vi.fn((table: string) => (table === "crm_tasks" ? taskBuilder : commentsBuilder));
    createClientMock.mockResolvedValue({ from });

    const response = await GET(new Request("http://local"), {
      params: Promise.resolve({ id: "task-a" }),
    });
    expect(response.status).toBe(200);
    expect(taskEq).toHaveBeenCalledWith("organization_id", "org-a");
    expect(commentsEq).toHaveBeenCalledWith("organization_id", "org-a");
    expect(commentsEq).toHaveBeenCalledWith("task_id", "task-a");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      data: { comments: [{ id: "comment-a" }], read_only: true },
    });
  });

  it("não consulta banco quando viewer é negado", async () => {
    requireRoleMock.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const response = await GET(new Request("http://local"), {
      params: Promise.resolve({ id: "task-a" }),
    });
    expect(response.status).toBe(403);
    expect(createClientMock).not.toHaveBeenCalled();
  });
});
