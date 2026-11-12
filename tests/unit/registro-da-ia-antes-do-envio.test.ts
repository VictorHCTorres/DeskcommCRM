/**
 * F4o do cxj (12/11/2026), O06: a saída da IA entra na contagem do número ANTES de acontecer.
 *
 * Até a versão 9, `runBeforeSend` chamava o transporte e só depois gravava o `pacing_ledger`
 * (e a cópia), na mesma transação. Se essa gravação ou o commit falhassem depois de a mensagem
 * sair, o rollback apagava o registro: a reserva seguinte da campanha não via a saída e liberava
 * o 61º disparo do dia, ou passava por cima do intervalo depois de uma resposta da IA.
 *
 * A régua deste arquivo:
 * - o registro é gravado na transação antes do transporte; recusado, nada sai;
 * - só um desfecho que prova que nada saiu agora o desfaz (já enviada antes, canal segurando,
 *   falha marcada pelo canal, veto, transporte indisponível, organização parada);
 * - o transporte que lança deixa a saída incerta, e o registro fica;
 * - quando a transação não confirma uma saída possível, o registro é gravado fora dela, depois
 *   de a conexão voltar ao pool, com o mesmo instante e a mesma marca de resposta.
 *
 * Sem PostgreSQL: o banco falso guarda só a semântica de transação que importa aqui (o que a
 * transação grava só fica se ela confirmar; `rollback to savepoint` desfaz o que veio depois
 * do savepoint). A prova no Postgres real está em
 * `tests/invariants/registro-da-ia-antes-do-envio.test.ts`.
 */
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { ChannelSendResult } from '@/lib/agent-engine/channel-adapter';
import { runBeforeSend, type RunBeforeSendArgs } from '@/lib/agent-engine/guardrails/before-send';
import { OrgNaoOperanteError } from '@/lib/organizacao/operante';

const ORG = '00000000-0000-4000-8000-000000000001';
const NUMERO = '00000000-0000-4000-8000-000000000004';
const AGORA = new Date('2026-11-16T13:00:00.000Z');
const RECUSA = 'recusado pelo banco falso';
const ENVIADA: ChannelSendResult = { kind: 'sent', idempotencyKey: 'k', messageId: 'm' };

type Tabela = 'pacing_ledger' | 'outbound_copies';
interface Linha {
  tabela: Tabela;
  params: unknown[];
}

function normalizar(sql: string): string {
  return String(sql).toLowerCase().trim().replace(/\s+/g, ' ');
}

function tabelaDoInsert(s: string): Tabela | null {
  if (s.startsWith('insert into pacing_ledger')) return 'pacing_ledger';
  if (s.startsWith('insert into outbound_copies')) return 'outbound_copies';
  return null;
}

interface Opcoes {
  /** O comando que a transação recusa (o `commit` inclusive: recusado, ele a desfaz). */
  recusarNaTransacao?: (s: string) => boolean;
  /** Quantas gravações do limite diário fora da transação o banco recusa antes de aceitar. */
  recusasForaDaTransacao?: number;
  /** O banco recusa a cópia gravada fora da transação. */
  recusarCopiaFora?: boolean;
}

function bancoFalso(opcoes: Opcoes = {}) {
  const eventos: string[] = [];
  const naTransacao: Linha[] = [];
  const foraDaTransacao: Linha[] = [];
  let pendentes: Linha[] = [];
  const marcas = new Map<string, number>();
  let recusasFora = opcoes.recusasForaDaTransacao ?? 0;

  const cliente = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const s = normalizar(sql);
      if (opcoes.recusarNaTransacao?.(s)) {
        eventos.push(`recusou:${s}`);
        if (s === 'commit') pendentes = [];
        throw Object.assign(new Error(RECUSA), { code: '55P03' });
      }
      if (s === 'begin') {
        pendentes = [];
        eventos.push('begin');
      } else if (s.startsWith('select pg_advisory_xact_lock')) {
        eventos.push('trava');
      } else if (s.startsWith('rollback to savepoint ')) {
        pendentes = pendentes.slice(0, marcas.get(s.slice('rollback to savepoint '.length)) ?? 0);
        eventos.push('desfez');
      } else if (s.startsWith('savepoint ')) {
        marcas.set(s.slice('savepoint '.length), pendentes.length);
      } else if (s === 'commit') {
        naTransacao.push(...pendentes);
        pendentes = [];
        eventos.push('commit');
      } else if (s === 'rollback') {
        pendentes = [];
        eventos.push('rollback');
      } else {
        const tabela = tabelaDoInsert(s);
        if (tabela) {
          pendentes.push({ tabela, params });
          eventos.push(`registro:${tabela}`);
        }
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn((erro?: Error) => {
      eventos.push(erro ? 'release-com-erro' : 'release');
    }),
  };

  const pool = {
    connect: vi.fn(async () => cliente),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const s = normalizar(sql);
      const tabela = tabelaDoInsert(s);
      if (tabela) {
        if (tabela === 'pacing_ledger' && recusasFora > 0) {
          recusasFora--;
          eventos.push('recusou:fora');
          throw new Error('banco fora do ar');
        }
        if (tabela === 'outbound_copies' && opcoes.recusarCopiaFora) throw new Error('banco fora do ar');
        foraDaTransacao.push({ tabela, params });
        eventos.push(`fora:${tabela}`);
        return { rows: [], rowCount: 1 };
      }
      if (s.startsWith('insert into before_send_traces')) return { rows: [{ id: 'trace-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };

  const linhas = (de: Linha[], tabela: Tabela) => de.filter((l) => l.tabela === tabela);
  return { pool: pool as unknown as pg.Pool, eventos, naTransacao, foraDaTransacao, linhas };
}

function argsDoTurno(
  pool: pg.Pool,
  send: RunBeforeSendArgs['send'],
  extras: Partial<RunBeforeSendArgs> = {},
): RunBeforeSendArgs {
  return {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: ORG,
    leadId: '00000000-0000-4000-8000-000000000002',
    jobId: '00000000-0000-4000-8000-000000000003',
    channelSessionId: NUMERO,
    body: 'Oi! Posso te explicar como funciona?',
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: AGORA,
    rng: () => 0,
    sleep: async () => {},
    gates: [],
    send,
    ...extras,
  };
}

describe('O06 · a saída da IA entra na contagem do número antes de acontecer', () => {
  it.each([false, true])(
    'envio confirmado (resposta=%s): o registro e a cópia são gravados antes do transporte e ficam',
    async (resposta) => {
      const banco = bancoFalso();
      const send = vi.fn(async () => {
        banco.eventos.push('envio');
        return ENVIADA;
      });

      const r = await runBeforeSend(argsDoTurno(banco.pool, send, { resposta }));

      expect(r.status).toBe('sent');
      const ev = banco.eventos;
      expect(ev).toContain('registro:pacing_ledger');
      expect(ev).toContain('registro:outbound_copies');
      expect(ev.indexOf('registro:pacing_ledger')).toBeLessThan(ev.indexOf('envio'));
      expect(ev.indexOf('registro:outbound_copies')).toBeLessThan(ev.indexOf('envio'));
      const registro = banco.linhas(banco.naTransacao, 'pacing_ledger');
      expect(registro).toHaveLength(1);
      expect(registro[0]!.params).toEqual([ORG, NUMERO, AGORA, resposta]);
      expect(banco.linhas(banco.naTransacao, 'outbound_copies')).toHaveLength(1);
      expect(banco.foraDaTransacao).toEqual([]);
    },
  );

  it.each([
    ['o limite diário', 'insert into pacing_ledger'],
    ['a cópia', 'insert into outbound_copies'],
  ])('registro recusado (%s): o transporte não é chamado, nada fica e o erro sobe', async (_nome, prefixo) => {
    const banco = bancoFalso({ recusarNaTransacao: (s) => s.startsWith(prefixo) });
    const send = vi.fn(async () => ENVIADA);

    await expect(runBeforeSend(argsDoTurno(banco.pool, send))).rejects.toThrow(RECUSA);

    expect(send).not.toHaveBeenCalled();
    expect(banco.eventos).toContain('rollback');
    expect(banco.naTransacao).toEqual([]);
    expect(banco.foraDaTransacao).toEqual([]);
  });

  it.each<ChannelSendResult>([
    { kind: 'already_sent', idempotencyKey: 'k', messageId: 'm' },
    { kind: 'queued', idempotencyKey: 'k', messageId: null },
    { kind: 'failed', idempotencyKey: 'k', messageId: null },
    { kind: 'blocked', idempotencyKey: 'k' },
    { kind: 'unavailable', reason: 'canal fora' },
  ])('desfecho $kind (nada saiu agora): o registro feito antes é desfeito e a transação fecha sem ele', async (desfecho) => {
    const banco = bancoFalso();
    const send = vi.fn(async () => {
      banco.eventos.push('envio');
      return desfecho;
    });

    await runBeforeSend(argsDoTurno(banco.pool, send));

    expect(send).toHaveBeenCalledTimes(1);
    const ev = banco.eventos;
    expect(ev.indexOf('registro:pacing_ledger')).toBeGreaterThan(-1);
    expect(ev.indexOf('registro:pacing_ledger')).toBeLessThan(ev.indexOf('envio'));
    expect(ev).toContain('commit');
    expect(banco.naTransacao).toEqual([]);
    expect(banco.foraDaTransacao).toEqual([]);
  });

  it('organização parada: o handler barra antes de tudo, nada saiu e o registro é desfeito', async () => {
    const banco = bancoFalso();
    const erro = new OrgNaoOperanteError(ORG, 'suspended');
    const send = vi.fn(async (): Promise<ChannelSendResult> => {
      throw erro;
    });

    await expect(runBeforeSend(argsDoTurno(banco.pool, send))).rejects.toBe(erro);

    expect(banco.eventos).toContain('registro:pacing_ledger');
    expect(banco.naTransacao).toEqual([]);
    expect(banco.foraDaTransacao).toEqual([]);
  });

  it.each([false, true])(
    'transporte que lança (saída incerta, resposta=%s): o registro fica e o erro do transporte sobe',
    async (resposta) => {
      const banco = bancoFalso();
      const erro = new Error('o provedor aceitou e a gravação do aceite falhou');
      const send = vi.fn(async (): Promise<ChannelSendResult> => {
        throw erro;
      });

      await expect(runBeforeSend(argsDoTurno(banco.pool, send, { resposta }))).rejects.toBe(erro);

      const registro = banco.linhas(banco.naTransacao, 'pacing_ledger');
      expect(registro).toHaveLength(1);
      expect(registro[0]!.params).toEqual([ORG, NUMERO, AGORA, resposta]);
      expect(banco.linhas(banco.naTransacao, 'outbound_copies')).toHaveLength(1);
      expect(banco.foraDaTransacao).toEqual([]);
      // A transação fecha uma vez: o commit que guardou o registro, sem rollback depois dele.
      expect(banco.eventos.filter((e) => e === 'commit' || e === 'rollback')).toEqual(['commit']);
    },
  );

  it.each([false, true])(
    'commit recusado depois do envio confirmado (resposta=%s): o registro é gravado fora da transação, depois de a conexão voltar ao pool',
    async (resposta) => {
      const banco = bancoFalso({ recusarNaTransacao: (s) => s === 'commit' });
      const send = vi.fn(async () => ENVIADA);
      const args = argsDoTurno(banco.pool, send, { resposta });

      await expect(runBeforeSend(args)).rejects.toThrow(RECUSA);

      expect(banco.naTransacao).toEqual([]);
      const fora = banco.linhas(banco.foraDaTransacao, 'pacing_ledger');
      expect(fora).toHaveLength(1);
      expect(fora[0]!.params).toEqual([ORG, NUMERO, AGORA, resposta]);
      expect(banco.linhas(banco.foraDaTransacao, 'outbound_copies')).toHaveLength(1);
      const ev = banco.eventos;
      expect(ev.indexOf('fora:pacing_ledger')).toBeGreaterThan(ev.indexOf('release-com-erro'));
      expect(ev.indexOf('release-com-erro')).toBeGreaterThan(-1);
      expect(args.log.warn).toHaveBeenCalledWith(
        expect.stringMatching(/fora da transação/),
        expect.objectContaining({ channel_session_id: NUMERO, sent_at: AGORA.toISOString(), resposta }),
      );
    },
  );

  it('transporte que lança e commit recusado: o registro vai fora da transação e o erro que sobe é o do transporte', async () => {
    const banco = bancoFalso({ recusarNaTransacao: (s) => s === 'commit' });
    const erro = new Error('tempo esgotado no provedor');
    const send = vi.fn(async (): Promise<ChannelSendResult> => {
      throw erro;
    });
    const args = argsDoTurno(banco.pool, send);

    await expect(runBeforeSend(args)).rejects.toBe(erro);

    expect(banco.naTransacao).toEqual([]);
    expect(banco.linhas(banco.foraDaTransacao, 'pacing_ledger')).toHaveLength(1);
    expect(args.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/saída incerta/),
      expect.objectContaining({ channel_session_id: NUMERO }),
    );
  });

  it('cópia de fora recusada: o limite diário fica gravado e o log leva o número e o instante', async () => {
    const banco = bancoFalso({ recusarNaTransacao: (s) => s === 'commit', recusarCopiaFora: true });
    const args = argsDoTurno(banco.pool, vi.fn(async () => ENVIADA));

    await expect(runBeforeSend(args)).rejects.toThrow(RECUSA);

    expect(banco.linhas(banco.foraDaTransacao, 'pacing_ledger')).toHaveLength(1);
    expect(banco.linhas(banco.foraDaTransacao, 'outbound_copies')).toEqual([]);
    expect(args.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/anti-repetição/),
      expect.objectContaining({ channel_session_id: NUMERO, sent_at: AGORA.toISOString() }),
    );
  });

  it('commit recusado num desfecho sem saída: nada é gravado fora da transação', async () => {
    const banco = bancoFalso({ recusarNaTransacao: (s) => s === 'commit' });
    const send = vi.fn(async (): Promise<ChannelSendResult> => ({ kind: 'queued', idempotencyKey: 'k', messageId: null }));

    await expect(runBeforeSend(argsDoTurno(banco.pool, send))).rejects.toThrow(RECUSA);

    expect(banco.naTransacao).toEqual([]);
    expect(banco.foraDaTransacao).toEqual([]);
  });

  it('registro de fora recusado duas vezes: a terceira tentativa grava', async () => {
    const banco = bancoFalso({ recusarNaTransacao: (s) => s === 'commit', recusasForaDaTransacao: 2 });
    const args = argsDoTurno(banco.pool, vi.fn(async () => ENVIADA));

    await expect(runBeforeSend(args)).rejects.toThrow(RECUSA);

    expect(banco.eventos.filter((e) => e === 'recusou:fora')).toHaveLength(2);
    expect(banco.linhas(banco.foraDaTransacao, 'pacing_ledger')).toHaveLength(1);
  });

  it('registro de fora sempre recusado: tenta três vezes, deixa no log o número e o instante, e o erro do commit sobe', async () => {
    const banco = bancoFalso({ recusarNaTransacao: (s) => s === 'commit', recusasForaDaTransacao: 99 });
    const args = argsDoTurno(banco.pool, vi.fn(async () => ENVIADA), { resposta: true });

    await expect(runBeforeSend(args)).rejects.toThrow(RECUSA);

    expect(banco.eventos.filter((e) => e === 'recusou:fora')).toHaveLength(3);
    expect(banco.foraDaTransacao).toEqual([]);
    expect(args.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/fora da transação/),
      expect.objectContaining({
        organization_id: ORG,
        channel_session_id: NUMERO,
        sent_at: AGORA.toISOString(),
        resposta: true,
      }),
    );
  });

  it('sem a janela de cópias (enforceSpinning false): o registro vai sem cópia, dentro e fora da transação', async () => {
    const dentro = bancoFalso();
    await runBeforeSend(argsDoTurno(dentro.pool, vi.fn(async () => ENVIADA), { enforceSpinning: false }));
    expect(dentro.linhas(dentro.naTransacao, 'pacing_ledger')).toHaveLength(1);
    expect(dentro.linhas(dentro.naTransacao, 'outbound_copies')).toEqual([]);

    const fora = bancoFalso({ recusarNaTransacao: (s) => s === 'commit' });
    await expect(
      runBeforeSend(argsDoTurno(fora.pool, vi.fn(async () => ENVIADA), { enforceSpinning: false })),
    ).rejects.toThrow(RECUSA);
    expect(fora.linhas(fora.foraDaTransacao, 'pacing_ledger')).toHaveLength(1);
    expect(fora.linhas(fora.foraDaTransacao, 'outbound_copies')).toEqual([]);
  });
});
