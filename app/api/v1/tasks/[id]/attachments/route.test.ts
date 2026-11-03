import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clickUpAssetFinalPath } from "@/lib/clickup/assets/paths";

const ORG = "11111111-1111-4111-8111-111111111111";
const TASK = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT = "33333333-3333-4333-8333-333333333333";

const h = vi.hoisted(() => {
  const rows: Record<string, Record<string, unknown>[]> = {};
  const download = vi.fn();
  function from(table: string) {
    const filters: Array<(row: Record<string, unknown>) => boolean> = [];
    const result = () =>
      (rows[table] ?? []).filter((row) => filters.every((filter) => filter(row)));
    const query = {
      select: () => query,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value);
        return query;
      },
      order: () => query,
      maybeSingle: async () => ({ data: result()[0] ?? null, error: null }),
      then: (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: result(), error: null }).then(resolve),
    };
    return query;
  }
  return { rows, download, from };
});

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({
    ok: true,
    user: { id: "user" },
    org: { orgId: ORG, role: "viewer" },
  })),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ from: h.from }) as unknown as SupabaseClient),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: vi.fn(() => ({
    storage: { from: () => ({ download: h.download }) },
  })),
}));

import { GET as list } from "./route";
import { GET as media } from "./[attachmentId]/media/route";

describe("anexos importados da tarefa", () => {
  beforeEach(() => {
    for (const key of Object.keys(h.rows)) delete h.rows[key];
    h.rows.crm_tasks = [{ id: TASK, organization_id: ORG }];
    h.rows.crm_task_attachments = [
      {
        id: ATTACHMENT,
        organization_id: ORG,
        task_id: TASK,
        file_name: "evidencia.pdf",
        file_size: 7,
        mime_type: "application/pdf",
        created_at: "2026-11-03T00:00:00Z",
        storage_path: clickUpAssetFinalPath({
          organizationId: ORG,
          workspaceId: "wk-1",
          targetKind: "tasks",
          targetId: TASK,
          sha256: "a".repeat(64),
          extension: "pdf",
        }),
      },
    ];
    h.download.mockReset().mockResolvedValue({
      data: new TextEncoder().encode("arquivo"),
      error: null,
    });
  });

  it("lista contrato estável com media_href tenant-safe", async () => {
    const response = await list(new Request("https://deskcomm.test"), {
      params: Promise.resolve({ id: TASK }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        files: [
          {
            id: ATTACHMENT,
            file_name: "evidencia.pdf",
            media_href: `/api/v1/tasks/${TASK}/attachments/${ATTACHMENT}/media`,
          },
        ],
      },
    });
  });

  it("baixa server-side com nosniff e recusa path de outro alvo", async () => {
    const context = { params: Promise.resolve({ id: TASK, attachmentId: ATTACHMENT }) };
    const response = await media(new Request("https://deskcomm.test"), context);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const attachment = h.rows.crm_task_attachments?.[0];
    expect(attachment).toBeDefined();
    attachment!.storage_path = String(attachment!.storage_path).replace(
      TASK,
      "44444444-4444-4444-8444-444444444444",
    );
    const denied = await media(new Request("https://deskcomm.test"), context);
    expect(denied.status).toBe(404);
  });
});
