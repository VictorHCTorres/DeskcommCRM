/**
 * O NÚMERO DE PROSPECÇÃO NA CADEIA DO AGENTE (Linha A, v20).
 *
 * O retorno que o agente marca sozinho (`callback_enabled`, "Permitir que o agente marque novos retornos por conta
 * própria"), o follow-up de IA e a retomada saem pela cadeia (`runBeforeSend`) como DISPARO. No número de uma campanha
 * de prospecção, a cadeia os barra fora da hora da prospecção (com a próxima abertura, que quem chama sabe adiar) e
 * pela pessoa (SAIR, etiqueta de parada, atendimento humano, recusa, lista de exclusão) — antes de tomar a trava do
 * número e de qualquer chamada de modelo. A resposta a quem escreveu não passa por esta trava.
 */
import { describe, expect, it, vi } from "vitest";

import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";

const SESSAO = "00000000-0000-4000-8000-000000005286";
const CONTATO = "00000000-0000-4000-8000-0000000000aa";

function pool(opcoes: { prospeccao?: boolean; tags?: string[]; blocked?: boolean } = {}) {
  const consultas: string[] = [];
  const query = vi.fn(async (sql: string) => {
    consultas.push(sql);
    if (/marca_da_prospeccao/.test(sql)) {
      return { rows: opcoes.prospeccao === false ? [] : [{ marca_da_prospeccao: "prospeccao", audience_filter: { sem_tags: ["sair", "tem-quem-cuide"] } }] };
    }
    if (/join channel_knobs/.test(sql)) {
      return { rows: [{ window_start_hour: 8, window_end_hour: 18, allow_sunday: false, prospeccao_dias: [1, 2, 3, 4, 5], timezone: "America/Fortaleza", warmup_daily_caps: null, number_activated_at: null }] };
    }
    if (/from contacts where organization_id/.test(sql)) {
      return { rows: [{ is_blocked: opcoes.blocked ?? false, tags: opcoes.tags ?? [], force_human: false, ai_opt_out: false, consent: null, phone_number: "+5588999990000" }] };
    }
    return { rows: [] };
  });
  const connect = vi.fn(async () => {
    throw new Error("a cadeia não pode tomar conexão quando a trava do número de prospecção recusa");
  });
  return { consultas, query, connect, pool: { query, connect } as never };
}
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const send = vi.fn();
const args = (p: ReturnType<typeof pool>, instante: string, resposta?: boolean) =>
  ({
    pool: p.pool,
    log,
    tenantId: "org-1",
    leadId: CONTATO,
    channelSessionId: SESSAO,
    body: "Oi! Voltando como combinamos.",
    send,
    relogio: () => new Date(instante),
    ...(resposta !== undefined ? { resposta } : {}),
  }) as never;

describe("v20 · a cadeia do agente no número de prospecção", () => {
  it("⭐ o retorno marcado pela IA para sexta 20/11 (feriado), 10h: vetado como fora da janela, com a abertura de segunda 23/11 às 8h", async () => {
    const p = pool();
    const r = await runBeforeSend(args(p, "2026-11-20T13:00:00Z"));
    expect(r).toMatchObject({ status: "vetoed", gate: "chip_de_prospeccao", code: "outside_window" });
    expect((r as { nextAllowedAt?: Date }).nextAllowedAt?.toISOString()).toBe("2026-11-23T11:00:00.000Z");
    expect(p.connect).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("⭐ às 7h59 de quarta: vetado; a próxima abertura é 8h00 do mesmo dia", async () => {
    const r = await runBeforeSend(args(pool(), "2026-11-18T10:59:00Z"));
    expect(r).toMatchObject({ status: "vetoed", code: "outside_window" });
    expect((r as { nextAllowedAt?: Date }).nextAllowedAt?.toISOString()).toBe("2026-11-18T11:00:00.000Z");
  });

  it("⭐ quem respondeu SAIR (bloqueado) não recebe o retorno, nem dentro da hora", async () => {
    const r = await runBeforeSend(args(pool({ blocked: true }), "2026-11-18T13:00:00Z"));
    expect(r).toMatchObject({ status: "vetoed", code: "chip_de_prospeccao:contato_bloqueado" });
    expect(send).not.toHaveBeenCalled();
  });

  it("⭐ etiqueta `tem-quem-cuide`: vetado", async () => {
    const r = await runBeforeSend(args(pool({ tags: ["tem-quem-cuide"] }), "2026-11-18T13:00:00Z"));
    expect(r).toMatchObject({ status: "vetoed", code: "chip_de_prospeccao:etiqueta_de_parada" });
  });

  it("controle: a RESPOSTA a quem escreveu não pergunta pelo número de prospecção", async () => {
    const p = pool();
    await runBeforeSend(args(p, "2026-11-20T13:00:00Z", true)).catch(() => undefined);
    expect(p.consultas.some((s) => /marca_da_prospeccao/.test(s))).toBe(false);
  });

  it("controle: número que não é de prospecção — a trava não veta (a cadeia segue e toma a conexão)", async () => {
    const p = pool({ prospeccao: false });
    await runBeforeSend(args(p, "2026-11-20T13:00:00Z")).catch(() => undefined);
    expect(p.connect).toHaveBeenCalled();
  });
});
