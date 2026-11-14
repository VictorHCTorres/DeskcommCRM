/**
 * O PASSO DE IA DO FLUXO NO NÚMERO DE PROSPECÇÃO (Linha A, v20).
 *
 * Antes de gastar o turno da IA, o `followup-turn` pergunta pela janela de disparo do número
 * (`aberturaDaJanelaDeDisparo`). No número de prospecção ele passa a perguntar também pelos dias da prospecção e pelo
 * feriado nacional (`chip-de-prospeccao.ts`): o passo adia para a próxima abertura, em vez de rodar o modelo para a
 * cadeia vetar depois.
 */
import { describe, expect, it, vi } from "vitest";

import { aberturaDaJanelaDeDisparo } from "@/lib/agent-engine/agent/followup-turn";

const ALVO = {
  tenantId: "org-1",
  leadId: "00000000-0000-4000-8000-0000000000aa",
  conversationId: "conv-1",
  channelSessionId: "00000000-0000-4000-8000-000000005286",
};
const KNOBS = { window_start_hour: 8, window_end_hour: 18, allow_sunday: false, prospeccao_dias: [1, 2, 3, 4, 5], timezone: "America/Fortaleza", warmup_daily_caps: null, number_activated_at: null };

function pool(prospeccao: boolean) {
  return {
    query: vi.fn(async (sql: string) => {
      if (/join channel_knobs/.test(sql)) return { rows: [KNOBS] };
      if (/marca_da_prospeccao/.test(sql)) return { rows: prospeccao ? [{ marca_da_prospeccao: "prospeccao", audience_filter: {} }] : [] };
      if (/from contacts where organization_id/.test(sql)) return { rows: [{ is_blocked: false, tags: [], force_human: false, ai_opt_out: false, consent: null, phone_number: null }] };
      return { rows: [] };
    }),
  } as never;
}

describe("v20 · a janela do passo de IA no número de prospecção", () => {
  it("⭐ sexta 20/11/2026, 10h (feriado, janela do número aberta): adia para segunda 23/11, 8h", async () => {
    const r = await aberturaDaJanelaDeDisparo(pool(true), ALVO, new Date("2026-11-20T13:00:00Z"), undefined);
    expect(r?.toISOString()).toBe("2026-11-23T11:00:00.000Z");
  });
  it("controle: o mesmo instante num número que não é de prospecção: não adia", async () => {
    expect(await aberturaDaJanelaDeDisparo(pool(false), ALVO, new Date("2026-11-20T13:00:00Z"), undefined)).toBeNull();
  });
  it("controle: quarta 18/11, 10h, no número de prospecção: não adia", async () => {
    expect(await aberturaDaJanelaDeDisparo(pool(true), ALVO, new Date("2026-11-18T13:00:00Z"), undefined)).toBeNull();
  });
});
