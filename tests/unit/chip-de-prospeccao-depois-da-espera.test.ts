/**
 * O NÚMERO DE PROSPECÇÃO — a hora é reconferida DEPOIS da espera do intervalo (Linha A, v20; achado C do revisor 1
 * e R2-01 do revisor 2).
 *
 * O defeito: o disparo do agente (retorno pontual, passo de IA do follow-up, retomada, Meet) tinha a hora do número
 * conferida só na ENTRADA de `runBeforeSend`. Depois vinham a fila da trava do número e a espera do intervalo, e nada
 * reconferia a janela: conferido às 17h59m50s, com 50 s de espera, saía às 18h00m40s. A campanha e o resgate
 * reconferem no último passo; o disparo do agente não reconferia.
 *
 * A regra: sob a trava do número, depois da espera e ANTES de registrar a saída, a trava do número de prospecção roda
 * de novo, na hora mais tardia em que a mensagem pode chegar ao provedor (o instante da saída mais a folga). Fechou:
 * `outside_window` com a próxima abertura, nada é registrado e o transporte não é chamado.
 */
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { ChannelSendResult } from '@/lib/agent-engine/channel-adapter';
import { pacingGate, runBeforeSend } from '@/lib/agent-engine/guardrails/before-send';

const ORG = '00000000-0000-4000-8000-000000000001';
const LEAD = '00000000-0000-4000-8000-000000000002';
const NUMERO = '00000000-0000-4000-8000-000000000004';
const ENVIADA: ChannelSendResult = { kind: 'sent', idempotencyKey: 'k', messageId: 'm' };

function knobs(throttleMs: number, janela: [number, number]) {
  return {
    throttle_ms: throttleMs,
    jitter_max_ms: 0,
    window_start_hour: janela[0],
    window_end_hour: janela[1],
    resposta_start_hour: null,
    resposta_end_hour: null,
    atraso_notar_ms: null,
    ms_por_caractere: null,
    atraso_minimo_ms: null,
    atraso_maximo_ms: null,
    allow_sunday: false,
    prospeccao_dias: [1, 2, 3, 4, 5],
    timezone: 'America/Fortaleza',
    warmup_daily_caps: null,
    number_activated_at: new Date('2026-01-01T00:00:00Z'),
    org_timezone: 'America/Fortaleza',
  };
}

function n(sql: string) {
  return String(sql).toLowerCase().replace(/\s+/g, ' ').trim();
}

interface Opcoes {
  inicio: string;
  ultimaSaida: string;
  throttleMs?: number;
  /** A janela de disparo do número; por omissão, 8h–18h. */
  janela?: [number, number];
  /** `false` = o número não é de campanha de prospecção. */
  deProspeccao?: boolean;
  /** A etiqueta que o contato ganha DEPOIS da conferência da entrada. */
  etiquetaDepoisDaEntrada?: string;
  resposta?: boolean;
}

function cenario(o: Opcoes) {
  let relogio = new Date(o.inicio).getTime();
  let leiturasDoContato = 0;
  const consultas: string[] = [];
  const responder = (sql: string) => {
    const s = n(sql);
    consultas.push(s);
    if (s.includes('left join channel_knobs')) return { rows: [knobs(o.throttleMs ?? 60_000, o.janela ?? [8, 18])], rowCount: 1 };
    if (s.startsWith('select (select sent_at from pacing_ledger'))
      return { rows: [{ last_sent_at: new Date(o.ultimaSaida), sent_today: '1' }], rowCount: 1 };
    if (s.includes("'prospeccao' as marca_da_prospeccao"))
      return o.deProspeccao === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{ marca_da_prospeccao: 'prospeccao', audience_filter: { sem_tags: ['sair'] } }], rowCount: 1 };
    if (s.startsWith('select is_blocked, tags, force_human')) {
      leiturasDoContato += 1;
      const tags = leiturasDoContato > 1 && o.etiquetaDepoisDaEntrada ? [o.etiquetaDepoisDaEntrada] : [];
      return {
        rows: [{ is_blocked: false, tags, force_human: false, ai_opt_out: false, consent: null, phone_number: null }],
        rowCount: 1,
      };
    }
    if (s.includes('insert into pacing_ledger') || s.includes('insert into outbound_copies'))
      return { rows: [{ id: 'linha-1' }], rowCount: 1 };
    if (s.startsWith('insert into before_send_traces')) return { rows: [{ id: 't' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const cliente = { query: vi.fn(async (sql: string) => responder(sql)), release: vi.fn() };
  const pool = { connect: vi.fn(async () => cliente), query: vi.fn(async (sql: string) => responder(sql)) };
  const enviadoAs: Date[] = [];
  const send = vi.fn(async () => {
    enviadoAs.push(new Date(relogio));
    return ENVIADA;
  });
  return {
    enviadoAs,
    send,
    consultas,
    run: () =>
      runBeforeSend({
        pool: pool as unknown as pg.Pool,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        tenantId: ORG,
        leadId: LEAD,
        jobId: '00000000-0000-4000-8000-000000000003',
        channelSessionId: NUMERO,
        body: 'Retomando o que combinamos sobre a sua marca.',
        optedOutThisTurn: false,
        crmDailyLimit: null,
        now: new Date(o.inicio),
        relogio: () => new Date(relogio),
        rng: () => 0,
        sleep: async (ms: number) => {
          relogio += ms;
        },
        resposta: o.resposta ?? false,
        gates: [pacingGate],
        send,
      }),
  };
}

const gravouALinha = (consultas: string[]) => consultas.some((s) => s.includes('insert into pacing_ledger'));

describe('v20 · o número de prospecção: a hora é reconferida depois da espera do intervalo (disparo do agente)', () => {
  it('controle: às 17h58m00s (quarta) com 50 s de espera, sai às 17h58m50s', async () => {
    const c = cenario({ inicio: '2026-11-18T20:58:00.000Z', ultimaSaida: '2026-11-18T20:57:50.000Z' });
    const r = await c.run();
    expect(r.status).toBe('sent');
    expect(c.enviadoAs.map((d) => d.toISOString())).toEqual(['2026-11-18T20:58:50.000Z']);
    expect(gravouALinha(c.consultas)).toBe(true);
  });

  it('⭐ às 17h59m50s com 50 s de espera: não sai às 18h00m40s; adia para a próxima abertura', async () => {
    const c = cenario({ inicio: '2026-11-18T20:59:50.000Z', ultimaSaida: '2026-11-18T20:59:40.000Z' });
    const r = await c.run();
    expect(c.send).not.toHaveBeenCalled();
    expect(r.status).toBe('vetoed');
    if (r.status !== 'vetoed') return;
    expect(r.gate).toBe('chip_de_prospeccao');
    expect(r.code).toBe('outside_window');
    // Quinta 19/11/2026, 8h00 em Fortaleza.
    expect(r.nextAllowedAt?.toISOString()).toBe('2026-11-19T11:00:00.000Z');
    expect(r.trace.at(-1)).toMatchObject({ gate: 'chip_de_prospeccao', verdict: 'veto', code: 'fora_da_janela_de_prospeccao' });
    // Nada entra no limite do número, e a transação é desfeita.
    expect(gravouALinha(c.consultas)).toBe(false);
    expect(c.consultas).toContain('rollback');
    expect(c.consultas).not.toContain('commit');
  });

  it('⭐ quinta 19/11 às 17h59m50s, véspera do feriado: a próxima abertura é segunda 23/11 às 8h00', async () => {
    const c = cenario({ inicio: '2026-11-19T20:59:50.000Z', ultimaSaida: '2026-11-19T20:59:40.000Z' });
    const r = await c.run();
    expect(c.send).not.toHaveBeenCalled();
    expect(r.status).toBe('vetoed');
    if (r.status !== 'vetoed') return;
    expect(r.code).toBe('outside_window');
    expect(r.nextAllowedAt?.toISOString()).toBe('2026-11-23T11:00:00.000Z');
  });

  it('⭐ o feriado também: com o número aberto o dia inteiro, a espera que vira a meia-noite de 20/11 não manda', async () => {
    // Quinta 19/11 às 23h59m50s em Fortaleza; 50 s depois é sexta 20/11 (feriado nacional), 0h00m40s.
    const c = cenario({
      inicio: '2026-11-20T02:59:50.000Z',
      ultimaSaida: '2026-11-20T02:59:40.000Z',
      janela: [0, 24],
    });
    const r = await c.run();
    expect(c.send).not.toHaveBeenCalled();
    expect(r.status).toBe('vetoed');
    if (r.status !== 'vetoed') return;
    expect(r.code).toBe('outside_window');
    expect(r.trace.at(-1)).toMatchObject({ gate: 'chip_de_prospeccao', code: 'feriado_nacional' });
    // Sábado e domingo não são dias da prospecção: segunda 23/11, 0h00.
    expect(r.nextAllowedAt?.toISOString()).toBe('2026-11-23T03:00:00.000Z');
    expect(gravouALinha(c.consultas)).toBe(false);
  });

  it('⭐ a folga do transporte conta: às 17h59m55s, sem espera, a mensagem poderia chegar ao provedor até 18h00m05s; não sai', async () => {
    const c = cenario({ inicio: '2026-11-18T20:59:55.000Z', ultimaSaida: '2026-11-18T20:00:00.000Z', throttleMs: 1200 });
    const r = await c.run();
    expect(c.send).not.toHaveBeenCalled();
    expect(r.status).toBe('vetoed');
    if (r.status !== 'vetoed') return;
    expect(r.code).toBe('outside_window');
    expect(gravouALinha(c.consultas)).toBe(false);
  });

  it('controle da folga: às 17h59m49s, sem espera, a hora mais tardia é 17h59m59s; sai', async () => {
    const c = cenario({ inicio: '2026-11-18T20:59:49.000Z', ultimaSaida: '2026-11-18T20:00:00.000Z', throttleMs: 1200 });
    const r = await c.run();
    expect(r.status).toBe('sent');
    expect(c.send).toHaveBeenCalledTimes(1);
  });

  it('⭐ a pessoa também: a etiqueta de parada que chegou durante a espera veta, e nada é registrado', async () => {
    const c = cenario({
      inicio: '2026-11-18T17:00:00.000Z',
      ultimaSaida: '2026-11-18T16:59:50.000Z',
      etiquetaDepoisDaEntrada: 'sair',
    });
    const r = await c.run();
    expect(c.send).not.toHaveBeenCalled();
    expect(r.status).toBe('vetoed');
    if (r.status !== 'vetoed') return;
    expect(r.code).toBe('chip_de_prospeccao:etiqueta_de_parada');
    expect(r.nextAllowedAt).toBeUndefined();
    expect(gravouALinha(c.consultas)).toBe(false);
  });

  it('não-regressão: num número que não é de prospecção, a espera que atravessa as 18h00 segue como antes', async () => {
    const c = cenario({
      inicio: '2026-11-18T20:59:50.000Z',
      ultimaSaida: '2026-11-18T20:59:40.000Z',
      deProspeccao: false,
    });
    const r = await c.run();
    expect(r.status).toBe('sent');
    expect(c.enviadoAs.map((d) => d.toISOString())).toEqual(['2026-11-18T21:00:40.000Z']);
  });

  it('não-regressão: a RESPOSTA a quem escreveu não passa pela trava do número (nem na entrada, nem depois da espera)', async () => {
    const c = cenario({
      inicio: '2026-11-18T17:00:00.000Z',
      ultimaSaida: '2026-11-18T16:59:50.000Z',
      etiquetaDepoisDaEntrada: 'sair',
      resposta: true,
    });
    const r = await c.run();
    expect(r.status).toBe('sent');
    expect(c.consultas.some((s) => s.includes("'prospeccao' as marca_da_prospeccao"))).toBe(false);
  });
});
