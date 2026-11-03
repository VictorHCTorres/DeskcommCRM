import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { renovarLeaseDoProcessadorDocs } from "./worker";

describe("lease do processador de Docs", () => {
  it("usa o heartbeat segregado por processor", async () => {
    const rpc = vi.fn(async () => ({ data: true, error: null }));
    await renovarLeaseDoProcessadorDocs({ rpc } as unknown as SupabaseClient, {
      runId: "run",
      workerId: "worker",
      leaseToken: "lease",
      checkpoint: { succeeded: 1 },
    });
    expect(rpc).toHaveBeenCalledWith("fn_heartbeat_clickup_import_processor", {
      p_run_id: "run",
      p_processor: "docs",
      p_worker_id: "worker",
      p_lease_token: "lease",
      p_checkpoint: { succeeded: 1 },
      p_lease_seconds: 90,
    });
  });

  it("falha fechado quando o CAS do lease devolve false", async () => {
    const rpc = vi.fn(async () => ({ data: false, error: null }));
    await expect(
      renovarLeaseDoProcessadorDocs({ rpc } as unknown as SupabaseClient, {
        runId: "run",
        workerId: "worker",
        leaseToken: "lease",
        checkpoint: {},
      }),
    ).rejects.toThrow("clickup_docs_processor_lease_lost");
  });
});
