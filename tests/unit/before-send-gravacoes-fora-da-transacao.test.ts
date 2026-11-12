/**
 * #2426 — nenhuma escrita com FK para `contacts` sai por OUTRA conexão enquanto a
 * transação de `runBeforeSend` está aberta.
 *
 * O #2121 tirou o classificador semântico de promessa de dentro da transação, encerrando a
 * aresta principal do ciclo medido no #2363 (`idle in transaction` por 8m47s, worker parado,
 * ~10 min de 503). Mas outras gravações ainda saíam pelo `args.pool` — OUTRA conexão — enquanto
 * a tx aberta segurava `contacts` (readStopFlags) sob o `pg_advisory_xact_lock` do número. Com um
 * DDL pendente em `contacts`, essas gravações enfileiravam atrás dele: o insert esperava o DDL,
 * o DDL esperava a tx e a tx esperava o insert — um ciclo que o Postgres não detecta porque uma
 * das arestas mora no Node. `before_send_traces` (persistTrace) é uma dessas arestas.
 *
 * A régua que este arquivo vira mecanismo: o `runBeforeSend` NÃO pode emitir nenhum `insert`/
 * `update`/`delete` pelo pool enquanto a transação do cliente está aberta (entre `begin` e
 * `commit`/`rollback`). As escritas duráveis (trace, timeline do veto, escalação LGPD) passaram
 * a acontecer DEPOIS do commit/rollback — autônomas no pool, sobrevivem ao rollback por natureza.
 *
 * Nasce VERMELHO: antes do conserto, `persistTrace` gravava `before_send_traces` pelo pool
 * DURANTE a tx (caminho enviado), e no veto as três escritas duráveis (trace + timeline +
 * escalação LGPD) rodavam antes do rollback. A sabotagem (reverter só o before-send.ts) reprova
 * os 3 casos daqui.
 *
 * F4p do cxj (12/11/2026), P05: a régua ficou mais dura. A auditoria pelo pool feita com a conexão
 * da cadeia ainda na mão (depois do commit, antes do `release`) esperava uma SEGUNDA conexão; num
 * pool de uma, a cadeia pendurava sem chegar ao `release`. Agora nenhuma escrita sai pelo pool
 * enquanto a cadeia segura a conexão, e o transporte (`args.send`, que no handler de produção grava
 * `send_ledger` e `messages` por outra conexão) só roda com a transação fechada e a conexão
 * devolvida: o registro da saída é confirmado antes dele. A prova com duas conexões e DDL na fila
 * está em `tests/invariants/before-send-auditoria-nao-fecha-ciclo-com-ddl.test.ts`.
 */
import type pg from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  runBeforeSend,
  type Gate,
  type RunBeforeSendArgs,
} from '@/lib/agent-engine/guardrails/before-send';

/** Estado compartilhado entre o cliente (que abre/fecha a tx) e o pool (que audita). */
interface EstadoTransacao {
  aberta: boolean;
  /** A cadeia está com a conexão na mão: do `connect` ao `release`. */
  conexaoNaMao: boolean;
}

/**
 * Cliente fake que espia o ciclo da transação: `begin` abre, `commit`/`rollback` fecham.
 * As leituras sob o lock devolvem linhas vazias — todos os loaders têm default para vazio
 * (o caminho feliz do #2506 já prova que `runBeforeSend` completa assim).
 */
function clienteComTransacao(): { cliente: pg.PoolClient; estado: EstadoTransacao } {
  const estado: EstadoTransacao = { aberta: false, conexaoNaMao: false };
  const cliente = {
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase().trim();
      if (s === 'begin') estado.aberta = true;
      if (s === 'commit' || s === 'rollback') estado.aberta = false;
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(() => {
      estado.conexaoNaMao = false;
    }),
  };
  return { cliente: cliente as unknown as pg.PoolClient, estado };
}

/**
 * Pool fake (a "outra conexão"). Toda escrita (`insert`/`update`/`delete`) é registrada; se ela
 * acontece com a transação ABERTA, entra em `violacoes` — é exatamente a aresta do #2426. O insert
 * em `before_send_traces` devolve um `id` para o caminho do veto exercitar a timeline.
 */
function poolAuditoriado(
  cliente: pg.PoolClient,
  estado: EstadoTransacao,
): { pool: pg.Pool; violacoes: string[]; comConexaoNaMao: string[]; escritas: string[] } {
  const violacoes: string[] = [];
  const comConexaoNaMao: string[] = [];
  const escritas: string[] = [];
  const pool = {
    connect: vi.fn(async () => {
      estado.conexaoNaMao = true;
      return cliente;
    }),
    query: vi.fn(async (sql: string) => {
      const s = String(sql).toLowerCase().trim();
      if (/^(insert|update|delete|with)\b/.test(s)) {
        escritas.push(s);
        if (estado.aberta) violacoes.push(s);
        if (estado.conexaoNaMao) comConexaoNaMao.push(s);
      }
      if (s.includes('insert into before_send_traces'))
        return { rows: [{ id: 'trace-1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }),
  };
  return { pool: pool as unknown as pg.Pool, violacoes, comConexaoNaMao, escritas };
}

function argsDoTurno(pool: pg.Pool, extras: Partial<RunBeforeSendArgs> = {}): RunBeforeSendArgs {
  return {
    pool,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    tenantId: '00000000-0000-4000-8000-000000000001',
    leadId: '00000000-0000-4000-8000-000000000002',
    jobId: '00000000-0000-4000-8000-000000000003',
    channelSessionId: '00000000-0000-4000-8000-000000000004',
    body: 'Olá! Segue o orçamento que você pediu.',
    optedOutThisTurn: false,
    crmDailyLimit: null,
    now: new Date('2026-09-17T12:00:00.000Z'),
    rng: () => 0,
    sleep: async () => {},
    gates: [],
    send: async () => ({ kind: 'sent', idempotencyKey: 'k', messageId: 'm' }),
    ...extras,
  };
}

/** Gate que veta sempre — para exercitar o caminho do veto (trace + timeline + escalação). */
function gateQueVeta(code: string): Gate {
  return { name: 'gate_de_teste', evaluate: () => ({ pass: false, code, reason: 'veto de teste' }) };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('#2426 e F4p · runBeforeSend não grava pelo pool com a transação aberta nem com a conexão na mão', () => {
  it('caminho enviado: o trace sai DEPOIS do commit e do release, nunca com a conexão na mão', async () => {
    const { cliente, estado } = clienteComTransacao();
    const { pool, violacoes, comConexaoNaMao, escritas } = poolAuditoriado(cliente, estado);

    const r = await runBeforeSend(argsDoTurno(pool));

    expect(r.status).toBe('sent');
    // A régua: nenhuma escrita pelo pool com a tx aberta, nem com a conexão da cadeia na mão.
    expect(violacoes, 'escrita pelo pool durante a transação aberta (#2426)').toEqual([]);
    expect(comConexaoNaMao, 'escrita pelo pool com a conexão da cadeia na mão (F4p, P05)').toEqual([]);
    // A auditoria continua existindo — só mudou o momento: depois do release.
    expect(escritas.some((s) => s.includes('insert into before_send_traces'))).toBe(true);
  });

  it('o transporte roda com a transação fechada e a conexão já devolvida ao pool (F4p, P05)', async () => {
    const { cliente, estado } = clienteComTransacao();
    const { pool } = poolAuditoriado(cliente, estado);
    let noEnvio: EstadoTransacao | undefined;

    const r = await runBeforeSend(
      argsDoTurno(pool, {
        send: async () => {
          noEnvio = { ...estado };
          return { kind: 'sent', idempotencyKey: 'k', messageId: 'm' };
        },
      }),
    );

    expect(r.status).toBe('sent');
    expect(noEnvio).toEqual({ aberta: false, conexaoNaMao: false });
  });

  it('veto (LGPD): trace + timeline + escalação saem DEPOIS do rollback e do release', async () => {
    const { cliente, estado } = clienteComTransacao();
    const { pool, violacoes, comConexaoNaMao, escritas } = poolAuditoriado(cliente, estado);

    const r = await runBeforeSend(
      argsDoTurno(pool, { gates: [gateQueVeta('lgpd_anonymized')] }),
    );

    expect(r.status).toBe('vetoed');
    expect(violacoes, 'escrita pelo pool durante a transação aberta (#2426)').toEqual([]);
    expect(comConexaoNaMao, 'escrita pelo pool com a conexão da cadeia na mão (F4p, P05)').toEqual([]);
    // O trace do veto é gravado (sobrevive ao rollback) — e o código lgpd_ dispara a escalação.
    expect(escritas.some((s) => s.includes('insert into before_send_traces'))).toBe(true);
    expect(escritas.some((s) => s.includes('insert into agent_inbox_items'))).toBe(true);
  });

  it('envio que ERRA: a auditoria é gravada depois de a transação fechar e a conexão voltar ao pool', async () => {
    const { cliente, estado } = clienteComTransacao();
    const { pool, violacoes, comConexaoNaMao, escritas } = poolAuditoriado(cliente, estado);

    await expect(
      runBeforeSend(
        argsDoTurno(pool, {
          send: async () => {
            throw new Error('transporte fora');
          },
        }),
      ),
    ).rejects.toThrow('transporte fora');

    expect(violacoes, 'escrita pelo pool durante a transação aberta (#2426)').toEqual([]);
    expect(comConexaoNaMao, 'escrita pelo pool com a conexão da cadeia na mão (F4p, P05)').toEqual([]);
    // A tentativa que errou ainda tem linha de auditoria (autônoma, gravada depois de a
    // conexão voltar ao pool). O transporte que lança deixa a saída incerta, e o registro no
    // limite diário do número, confirmado antes dele, fica
    // (`tests/unit/registro-da-ia-antes-do-envio.test.ts`).
    expect(escritas.some((s) => s.includes('insert into before_send_traces'))).toBe(true);
  });
});
