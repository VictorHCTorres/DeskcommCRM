import { describe, expect, it } from "vitest";

import { JANELA_LONGA_DA_RESERVA_MS } from "@/lib/api/idempotency";

import {
  CLICKUP_DISCOVERY_CONCURRENCY,
  CLICKUP_DISCOVERY_DEADLINE_MS,
  CLICKUP_MIN_REQUEST_INTERVAL_MS,
  discoverClickUpCrmApi,
} from "./discovery-api";

describe("descoberta CRM pela API ClickUp", () => {
  it("hidrata List folderless, bindings, tasks e omite URLs assinadas", async () => {
    const requested: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requested.push(String(input));
      const path = new URL(String(input)).pathname;
      const url = new URL(String(input));
      const body = path.endsWith("/team/w1/space")
        ? { spaces: [{ id: "s1", name: "Área" }] }
        : path.endsWith("/space/s1/folder")
          ? { folders: [] }
          : path.endsWith("/space/s1/list")
            ? {
                lists: [
                  {
                    id: "l1",
                    name: "Funil",
                    statuses: [{ id: "closed", status: "Feito", type: "done" }],
                  },
                ],
              }
            : path.endsWith("/list/l1")
              ? {
                  id: "l1",
                  name: "Funil",
                  statuses: [{ id: "closed", status: "Feito", type: "done" }],
                }
              : path.endsWith("/list/l1/field")
                ? { fields: [{ id: "f1", name: "Data", type: "date", type_config: {} }] }
                : {
                    tasks:
                      url.searchParams.get("page") === "0"
                        ? Array.from({ length: 100 }, (_, index) => ({
                            id: `t${index + 1}`,
                            name: "Registro",
                            status: { id: "closed", type: "done" },
                            date_done: "1730619000000",
                            priority: { priority: "high" },
                            tags: [{ name: "VIP", tag_bg: "#fff" }],
                            start_date: "1710052200000",
                            time_estimate: 0,
                            watchers: [{ id: 42, email: "nao-persistir@example.com" }],
                            linked_tasks: index === 0 ? [{ task_id: "t1", link_id: "t101" }] : [],
                            attachments:
                              index === 0 ? [{ url: "https://signed.example/secret" }] : [],
                          }))
                        : [{ id: "t101", name: "Segunda página", status: { id: "closed" } }],
                    last_page: url.searchParams.get("page") === "1",
                  };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const objects = await discoverClickUpCrmApi({
      workspaceId: "w1",
      token: "secret",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    expect(objects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source_type: "list", source_id: "l1", parent_source_id: "s1" }),
        expect.objectContaining({ source_type: "status", source_id: "l1:closed" }),
        expect.objectContaining({ source_type: "custom_field", source_id: "l1:f1" }),
        expect.objectContaining({
          source_type: "task",
          source_id: "t1",
          metadata: expect.objectContaining({
            date_done: "1730619000000",
            attachment_count: 1,
            priority: "high",
            tags: [{ name: "VIP", color: "#fff" }],
            watcher_ids: ["42"],
          }),
        }),
      ]),
    );
    expect(JSON.stringify(objects)).not.toContain("signed.example");
    expect(JSON.stringify(objects)).not.toContain("nao-persistir@example.com");
    expect(objects).toContainEqual(
      expect.objectContaining({ source_type: "task_relation", source_id: "linked:t1:t101" }),
    );
    expect(requested.some((url) => url.includes("archived=true"))).toBe(true);
    expect(requested.some((url) => url.includes("include_timl=true"))).toBe(true);
    expect(objects.filter((object) => object.source_type === "task")).toHaveLength(101);
    expect(objects).toContainEqual(
      expect.objectContaining({
        source_type: "task",
        source_id: "t101",
        metadata: expect.objectContaining({
          attachment_count: null,
          attachment_status: "unknown_not_exported",
        }),
      }),
    );
  });

  it("repete 429/5xx, respeita Retry-After e não repete 401/403", async () => {
    let clock = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const retryFetch = (async () => {
      calls += 1;
      if (calls === 1)
        return new Response("rate", { status: 429, headers: { "retry-after": "1" } });
      return new Response(JSON.stringify({ spaces: [] }), { status: 200 });
    }) as typeof fetch;
    await expect(
      discoverClickUpCrmApi({
        workspaceId: "w1",
        token: "secret",
        fetchImpl: retryFetch,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        minRequestIntervalMs: 0,
      }),
    ).resolves.toHaveLength(1);
    // retry da primeira passagem + passagens active/archived do workspace
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_000]);

    for (const status of [401, 403]) {
      calls = 0;
      const deniedFetch = (async () => {
        calls += 1;
        return new Response("denied", { status });
      }) as typeof fetch;
      await expect(
        discoverClickUpCrmApi({
          workspaceId: "w1",
          token: "secret",
          fetchImpl: deniedFetch,
          sleep: async () => undefined,
          minRequestIntervalMs: 0,
        }),
      ).rejects.toThrow(`clickup_api_http_${status}`);
      expect(calls).toBe(1);
    }
  });

  it("limita Retry-After e encerra pelo deadline global antes da reserva idempotente", async () => {
    expect(CLICKUP_DISCOVERY_DEADLINE_MS).toBeLessThan(JANELA_LONGA_DA_RESERVA_MS);
    let clock = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const rateLimitedFetch = (async () => {
      calls += 1;
      return new Response("rate", { status: 429, headers: { "retry-after": "999999" } });
    }) as typeof fetch;

    await expect(
      discoverClickUpCrmApi({
        workspaceId: "w1",
        token: "secret",
        fetchImpl: rateLimitedFetch,
        deadlineMs: 4_000,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        minRequestIntervalMs: 0,
      }),
    ).rejects.toThrow("clickup_discovery_deadline_exceeded");

    expect(calls).toBe(1);
    expect(sleeps).toEqual([4_000]);
    expect(sleeps[0]).toBe(4_000);
  });

  it("bloqueia explicitamente a mesma Task vinculada a duas Lists", async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname;
      const body = path.endsWith("/team/w1/space")
        ? { spaces: [{ id: "s1", name: "Área" }] }
        : path.endsWith("/space/s1/folder")
          ? { folders: [] }
          : path.endsWith("/space/s1/list")
            ? {
                lists: [
                  { id: "l1", name: "Um" },
                  { id: "l2", name: "Dois" },
                ],
              }
            : path.endsWith("/field")
              ? { fields: [] }
              : /\/list\/l\d$/.test(path)
                ? { id: path.endsWith("l1") ? "l1" : "l2", name: "Lista", statuses: [] }
                : { tasks: [{ id: "task-compartilhada", name: "Task" }], last_page: true };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await expect(
      discoverClickUpCrmApi({
        workspaceId: "w1",
        token: "secret",
        fetchImpl,
        minRequestIntervalMs: 0,
      }),
    ).rejects.toThrow("clickup_task_multiple_lists:task-compartilhada");
  });

  it("limita a concorrência de hidratação das Lists", async () => {
    let active = 0;
    let maximum = 0;
    const lists = Array.from({ length: 9 }, (_, index) => ({ id: `l${index}`, name: `L${index}` }));
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const path = url.pathname;
      let body: unknown;
      if (path.endsWith("/team/w1/space")) body = { spaces: [{ id: "s1", name: "Área" }] };
      else if (path.endsWith("/space/s1/folder")) body = { folders: [] };
      else if (path.endsWith("/space/s1/list")) body = { lists };
      else if (path.endsWith("/field")) body = { fields: [] };
      else if (path.endsWith("/task")) body = { tasks: [], last_page: true };
      else {
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        const id = path.split("/").at(-1)!;
        body = { id, name: id, statuses: [] };
      }
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    await discoverClickUpCrmApi({
      workspaceId: "w1",
      token: "secret",
      fetchImpl,
      minRequestIntervalMs: 0,
    });
    expect(maximum).toBe(CLICKUP_DISCOVERY_CONCURRENCY);
  });

  it("limita globalmente a cadência para não ultrapassar 100 requests por minuto", async () => {
    let clock = 0;
    const callsAt: number[] = [];
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      callsAt.push(clock);
      return new Response(JSON.stringify({ spaces: [] }), { status: 200 });
    }) as typeof fetch;

    await discoverClickUpCrmApi({
      workspaceId: "w1",
      token: "secret",
      fetchImpl,
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });

    expect(callsAt).toEqual([0, CLICKUP_MIN_REQUEST_INTERVAL_MS]);
    expect(sleeps).toEqual([CLICKUP_MIN_REQUEST_INTERVAL_MS]);
    expect(CLICKUP_MIN_REQUEST_INTERVAL_MS).toBeGreaterThan(60_000 / 100);
  });

  it("aguarda o reset informado pelo ClickUp antes de repetir um 429", async () => {
    let clock = 1_000;
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response("rate", {
          status: 429,
          headers: { "x-ratelimit-reset": "11" },
        });
      }
      return new Response("denied", { status: 401 });
    }) as typeof fetch;

    await expect(
      discoverClickUpCrmApi({
        workspaceId: "w1",
        token: "secret",
        fetchImpl,
        now: () => clock,
        sleep: async (ms) => {
          sleeps.push(ms);
          clock += ms;
        },
        minRequestIntervalMs: 0,
      }),
    ).rejects.toThrow("clickup_api_http_401");

    expect(calls).toBe(2);
    expect(sleeps).toEqual([10_250]);
  });
});
