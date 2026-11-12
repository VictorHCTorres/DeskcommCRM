/**
 * F4o do cxj (12/11/2026), O07: o teto do CRM do número vale também para o agente.
 *
 * O turno de entrada, o follow-up, o aviso de escalação e a prévia chamam `runBeforeSend` com
 * `crmDailyLimit: null` (o próprio turno dizia: "channel_sessions.daily_message_limit do CRM
 * ainda não é lido no runtime"). Sem ele, o disparo do agente só esbarrava no aquecimento:
 * num chip de 19 dias, 200 por dia contra os 60 do CRM que a campanha respeita.
 *
 * A régua: quando o chamador não traz o teto, a cadeia o lê do número, sob a trava, e o entrega
 * ao gate de pacing; quando traz, vale o dele, sem nova leitura. A prova no Postgres real está em
 * `tests/invariants/registro-da-ia-antes-do-envio.test.ts` (O07).
 */
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import {
  runBeforeSend,
  type Gate,
  type GateContext,
  type RunBeforeSendArgs,
} from '@/lib/agent-engine/guardrails/before-send';

const ORG = '00000000-0000-4000-8000-000000000001';
const NUMERO = '00000000-0000-4000-8000-000000000004';
const LEITURA_DO_TETO = /select daily_message_limit from channel_sessions/;

function cadeia(limiteDoNumero: number | null | undefined) {
  const eventos: string[] = [];
  const cliente = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const s = String(sql).toLowerCase().replace(/\s+/g, ' ').trim();
      if (s.startsWith('select pg_advisory_xact_lock')) eventos.push('trava');
      if (LEITURA_DO_TETO.test(s)) {
        eventos.push('leu-o-teto');
        // O número da organização do job, e só ele.
        expect(s).toContain('where organization_id = $1 and id = $2');
        expect(params).toEqual([ORG, NUMERO]);
        return { rows: limiteDoNumero === undefined ? [] : [{ daily_message_limit: limiteDoNumero }] };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => cliente),
    query: vi.fn(async () => ({ rows: [{ id: 'trace-1' }], rowCount: 1 })),
  } as unknown as pg.Pool;
  let visto: GateContext['pacing']['crmDailyLimit'] | 'nao-avaliou' = 'nao-avaliou';
  const espia: Gate = {
    name: 'espia_do_teto',
    evaluate: (ctx) => {
      visto = ctx.pacing.crmDailyLimit;
      return { pass: true };
    },
  };
  const rodar = (crmDailyLimit: number | null) =>
    runBeforeSend({
      pool,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      tenantId: ORG,
      leadId: '00000000-0000-4000-8000-000000000002',
      jobId: '00000000-0000-4000-8000-000000000003',
      channelSessionId: NUMERO,
      body: 'Oi! Lembrei de você.',
      optedOutThisTurn: false,
      crmDailyLimit,
      now: new Date('2026-11-16T13:00:00.000Z'),
      rng: () => 0,
      sleep: async () => {},
      gates: [espia],
      send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm' }),
    } satisfies RunBeforeSendArgs);
  return { rodar, eventos, visto: () => visto };
}

describe('O07 · o teto do CRM do número vale também para o agente', () => {
  it('chamador sem o teto (null): a cadeia lê o limite do número, sob a trava, e o gate recebe os 60', async () => {
    const c = cadeia(60);
    await c.rodar(null);
    expect(c.visto()).toBe(60);
    expect(c.eventos).toEqual(['trava', 'leu-o-teto']);
  });

  it('chamador com o teto: vale o dele, sem nova leitura', async () => {
    const c = cadeia(60);
    await c.rodar(30);
    expect(c.visto()).toBe(30);
    expect(c.eventos).not.toContain('leu-o-teto');
  });

  it.each([
    ['sem limite no CRM', null],
    ['sem a linha do número', undefined],
  ] as const)('%s: o teto segue sem limite (null)', async (_nome, limite) => {
    const c = cadeia(limite);
    await c.rodar(null);
    expect(c.visto()).toBeNull();
    expect(c.eventos).toContain('leu-o-teto');
  });
});
