import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/clickup/store", () => ({ stageClickUpPreview: vi.fn() }));
vi.mock("@/lib/api/idempotency", () => ({
  chaveDaRequisicao: vi.fn(() => "00000000-0000-4000-8000-000000000099"),
  comIdempotencia: vi.fn(async () => ({
    tipo: "executou",
    resposta: {
      id: "00000000-0000-4000-8000-000000000098",
      source: "bundle",
      scope: "docs",
      total_items: 1,
      warnings_count: 1,
    },
  })),
}));

import { requireRole } from "@/lib/auth/require-role";

import { POST } from "./route";

function manifesto(explicito: boolean) {
  return {
    connection_id: "00000000-0000-4000-8000-000000000001",
    workspace_id: "wk",
    source: "bundle",
    scope: "docs",
    manifest_version: 3,
    source_revision: "r1",
    objects: [
      {
        source_type: "doc",
        source_id: "d1",
        metadata: {
          visibility: "PRIVATE",
          private_scope_explicit: explicito,
        },
        content_access: "full",
        payload: { format: "markdown", content: "conteúdo" },
      },
    ],
  };
}

function request(explicito: boolean) {
  return new Request("https://deskcomm.test/api/v1/clickup/imports/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(manifesto(explicito)),
  });
}

function authz(role: "manager" | "admin") {
  return {
    ok: true,
    user: {
      id: "user",
      idioma: "pt-BR",
      is_platform_admin: false,
      platform_admin_scope: null,
    },
    org: { orgId: "org", role },
  };
}

describe("preview de Docs privados do ClickUp", () => {
  beforeEach(() => vi.mocked(requireRole).mockReset());

  it("nega manager mesmo quando o payload pede inclusão", async () => {
    vi.mocked(requireRole).mockResolvedValue(authz("manager") as never);
    const response = await POST(request(true));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "forbidden_role" } });
  });

  it("exige opt-in explícito do admin", async () => {
    vi.mocked(requireRole).mockResolvedValue(authz("admin") as never);
    const response = await POST(request(false));
    expect(response.status).toBe(422);
  });

  it("admin com opt-in recebe aviso org-wide", async () => {
    vi.mocked(requireRole).mockResolvedValue(authz("admin") as never);
    const response = await POST(request(true));
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      data: { privacy_warning: expect.stringContaining("toda a organização") },
    });
  });
});
