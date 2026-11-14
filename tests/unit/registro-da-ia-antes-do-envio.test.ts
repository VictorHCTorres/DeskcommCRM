/**
 * F4o e F4p do cxj (12/11/2026): a saída da IA está no limite do número ANTES de o transporte ser
 * chamado, confirmada.
 *
 * Até a versão 9, `runBeforeSend` chamava o transporte e só depois gravava o `pacing_ledger` (e a
 * cópia), na mesma transação: um rollback depois da saída apagava o registro (O06). A versão 10
 * gravou antes, mas na mesma transação do envio, e um commit recusado depois da saída deixava a
 * reserva da campanha passar (P01), ou só um log (P02); a auditoria esperava outra conexão com a
 * da cadeia na mão (P05).
 *
 * A régua deste arquivo (versão 11):
 * - a linha do limite diário e a cópia são confirmadas numa transação que termina antes do
 *   transporte; a conexão volta ao pool, e só então o transporte é chamado; recusado o registro
 *   ou o commit, nada sai;
 * - só um desfecho que prova que nada saiu apaga a linha e a cópia desta tentativa, pelo id, num
 *   comando só (já enviada antes, canal segurando, falha marcada pelo canal, contato bloqueado,
 *   transporte indisponível, organização parada); se o banco recusar, elas ficam (uma a mais) e o
 *   log leva o número, o instante e o desfecho;
 * - o transporte que lança deixa a saída incerta, e o registro fica;
 * - a auditoria é gravada depois de tudo, sem a conexão da cadeia na mão.
 *
 * Sem PostgreSQL: o banco falso guarda só a semântica que importa aqui (o que a transação grava só
 * fica se ela confirmar). A prova no Postgres real está em
 * `tests/invariants/registro-da-ia-antes-do-envio.test.ts`.
 */
import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { ChannelSendResult } from '@/lib/agent-engine/channel-adapter';
import { runBeforeSend, type RunBeforeSendArgs } from '@/lib/agent-engine/guardrails/before-send';
import { sendInBubbles } from '@/lib/agent-engine/agent/split-message';
import { OrgNaoOperanteError } from '@/lib/organizacao/operante';
import { erroComSaidaParcial } from '@/lib/agent-engine/saida-parcial';

const ORG = '00000000-0000-4000-8000-000000000001';
const NUMERO = '00000000-0000-4000-8000-000000000004';
const AGORA = new Date('2026-11-16T13:00:00.000Z');
const RECUSA = 'recusado pelo banco falso';
const ENVIADA: ChannelSendResult = { kind: 'sent', idempotencyKey: 'k', messageId: 'm' };

type Tabela = 'pacing_ledger' | 'outbound_copies';
interface Linha {
  id: string;
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
  /** O banco recusa o comando que apaga o registro de uma saída que não aconteceu. */
  recusarApagar?: boolean;
}

function bancoFalso(opcoes: Opcoes = {}) {
  const eventos: string[] = [];
  const confirmadas: Linha[] = [];
  let pendentes: Linha[] = [];
  let ids = 0;

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
      } else if (s === 'commit') {
        confirmadas.push(...pendentes);
        pendentes = [];
        eventos.push('commit');
      } else if (s === 'rollback') {
        pendentes = [];
        eventos.push('rollback');
      } else {
        const tabela = tabelaDoInsert(s);
        if (tabela) {
          const id = `${tabela}-${++ids}`;
          pendentes.push({ id, tabela, params });
          eventos.push(`registro:${tabela}`);
          return { rows: [{ id }], rowCount: 1 };
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
      if (s.includes('delete from pacing_ledger')) {
        if (opcoes.recusarApagar) {
          eventos.push('recusou:apagar');
          throw new Error('banco fora do ar');
        }
        // Um comando só: a linha do limite ($3) e a cópia ($4), do número e da organização.
        const alvo = (l: Linha) =>
          l.params[0] === params[0] &&
          l.params[1] === params[1] &&
          ((l.tabela === 'pacing_ledger' && l.id === params[2]) || (l.tabela === 'outbound_copies' && l.id === params[3]));
        const antes = confirmadas.length;
        for (let i = confirmadas.length - 1; i >= 0; i--) if (alvo(confirmadas[i]!)) confirmadas.splice(i, 1);
        eventos.push(`apagou:${antes - confirmadas.length}`);
        return { rows: [], rowCount: antes - confirmadas.length };
      }
      if (s.startsWith('insert into before_send_traces')) {
        eventos.push('auditoria');
        return { rows: [{ id: 'trace-1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  const linhas = (tabela: Tabela) => confirmadas.filter((l) => l.tabela === tabela);
  return { pool: pool as unknown as pg.Pool, eventos, linhas };
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

describe('F4o/F4p · a saída da IA está confirmada no limite do número antes do transporte', () => {
  it.each([false, true])(
    'saída confirmada (resposta=%s): linha e cópia confirmadas, conexão devolvida, e só então o transporte',
    async (resposta) => {
      const banco = bancoFalso();
      const send = vi.fn(async () => {
        banco.eventos.push('transporte');
        return ENVIADA;
      });

      const r = await runBeforeSend(argsDoTurno(banco.pool, send, { resposta }));

      expect(r).toMatchObject({ status: 'sent', outcome: ENVIADA });
      expect(banco.eventos).toEqual([
        'begin',
        'trava',
        'registro:pacing_ledger',
        'registro:outbound_copies',
        'commit',
        'release',
        'transporte',
        'auditoria',
      ]);
      expect(banco.linhas('pacing_ledger').map((l) => l.params)).toEqual([[ORG, NUMERO, AGORA, resposta]]);
      expect(banco.linhas('outbound_copies')).toHaveLength(1);
      expect(banco.linhas('outbound_copies')[0]!.params.slice(0, 2)).toEqual([ORG, NUMERO]);
    },
  );

  it.each([
    { kind: 'already_sent', idempotencyKey: 'k', messageId: 'm' },
    { kind: 'queued', idempotencyKey: 'k', messageId: null },
    { kind: 'failed', idempotencyKey: 'k', messageId: null },
    { kind: 'blocked', idempotencyKey: 'k' },
    { kind: 'unavailable', reason: 'transporte fora' },
  ] satisfies ChannelSendResult[])(
    'desfecho que prova que nada saiu agora ($kind): a linha e a cópia desta tentativa são apagadas num comando só, e o desfecho volta',
    async (desfecho) => {
      const banco = bancoFalso();
      const send = vi.fn(async () => desfecho);

      const r = await runBeforeSend(argsDoTurno(banco.pool, send));

      expect(r).toMatchObject({ status: 'sent', outcome: desfecho });
      expect(banco.eventos.slice(-3)).toEqual(['release', 'apagou:2', 'auditoria']);
      expect(banco.linhas('pacing_ledger')).toEqual([]);
      expect(banco.linhas('outbound_copies')).toEqual([]);
    },
  );

  it('organização parada: o handler barra antes de tudo, nada saiu, o registro é apagado e o erro sobe', async () => {
    const banco = bancoFalso();
    const erro = new OrgNaoOperanteError('suspensa');

    await expect(
      runBeforeSend(
        argsDoTurno(banco.pool, async () => {
          throw erro;
        }),
      ),
    ).rejects.toBe(erro);

    expect(banco.eventos.slice(-3)).toEqual(['release', 'apagou:2', 'auditoria']);
    expect(banco.linhas('pacing_ledger')).toEqual([]);
  });

  it.each([false, true])(
    'transporte que lança (saída incerta; resposta=%s): o registro fica, o erro sobe, e a auditoria é gravada',
    async (resposta) => {
      const banco = bancoFalso();
      const erro = new Error('tempo esgotado no provedor');

      await expect(
        runBeforeSend(
          argsDoTurno(
            banco.pool,
            async () => {
              throw erro;
            },
            { resposta },
          ),
        ),
      ).rejects.toBe(erro);

      expect(banco.eventos.slice(-2)).toEqual(['release', 'auditoria']);
      expect(banco.linhas('pacing_ledger').map((l) => l.params)).toEqual([[ORG, NUMERO, AGORA, resposta]]);
      expect(banco.linhas('outbound_copies')).toHaveLength(1);
    },
  );

  it.each([
    ['no commit', (s: string) => s === 'commit'],
    ['na gravação da linha do limite', (s: string) => s.startsWith('insert into pacing_ledger')],
    ['na gravação da cópia', (s: string) => s.startsWith('insert into outbound_copies')],
  ])('recusa do banco %s: o transporte não é chamado, nada fica confirmado, e o erro sobe', async (_n, recusar) => {
    const banco = bancoFalso({ recusarNaTransacao: recusar });
    const send = vi.fn(async () => ENVIADA);
    const args = argsDoTurno(banco.pool, send);

    await expect(runBeforeSend(args)).rejects.toThrow(RECUSA);

    expect(send).not.toHaveBeenCalled();
    expect(banco.linhas('pacing_ledger')).toEqual([]);
    expect(banco.linhas('outbound_copies')).toEqual([]);
    expect(banco.eventos).not.toContain('commit');
    // A conexão do erro não volta ao pool para ser reemprestada no meio de uma transação.
    expect(banco.eventos).toContain('release-com-erro');
    // A auditoria da tentativa que errou vem depois de a conexão voltar ao pool.
    expect(banco.eventos.slice(-2)).toEqual(['release-com-erro', 'auditoria']);
    expect(args.log.error).not.toHaveBeenCalled();
  });

  it('apagar recusado pelo banco: a linha e a cópia ficam (uma a mais), o desfecho volta, e o log leva o número, o instante e o desfecho', async () => {
    const banco = bancoFalso({ recusarApagar: true });
    const args = argsDoTurno(banco.pool, async () => ({ kind: 'failed', idempotencyKey: 'k', messageId: null }));

    const r = await runBeforeSend(args);

    expect(r).toMatchObject({ status: 'sent', outcome: { kind: 'failed' } });
    expect(banco.linhas('pacing_ledger')).toHaveLength(1);
    expect(banco.linhas('outbound_copies')).toHaveLength(1);
    expect(args.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/não foi apagado/),
      expect.objectContaining({
        organization_id: ORG,
        channel_session_id: NUMERO,
        sent_at: AGORA.toISOString(),
        resposta: false,
        desfecho: 'failed',
        error: 'Error',
      }),
    );
  });

  it('organização parada e apagar recusado: o registro fica, o log diz, e o erro que sobe é o da organização', async () => {
    const banco = bancoFalso({ recusarApagar: true });
    const erro = new OrgNaoOperanteError('suspensa');
    const args = argsDoTurno(banco.pool, async () => {
      throw erro;
    });

    await expect(runBeforeSend(args)).rejects.toBe(erro);

    expect(banco.linhas('pacing_ledger')).toHaveLength(1);
    expect(args.log.error).toHaveBeenCalledWith(
      expect.stringMatching(/não foi apagado/),
      expect.objectContaining({ channel_session_id: NUMERO, desfecho: 'org_nao_operante' }),
    );
  });

  it('veto com o rollback recusado: nada sai, o erro do rollback sobe, e a auditoria leva o veto', async () => {
    const banco = bancoFalso({ recusarNaTransacao: (s) => s === 'rollback' });
    const send = vi.fn(async () => ENVIADA);
    const gateQueVeta = {
      name: 'gate_de_teste',
      evaluate: () => ({ pass: false as const, code: 'codigo_de_teste', reason: 'veto de teste' }),
    };

    await expect(runBeforeSend(argsDoTurno(banco.pool, send, { gates: [gateQueVeta] }))).rejects.toThrow(
      /rollback falhou/,
    );

    expect(send).not.toHaveBeenCalled();
    expect(banco.eventos.slice(-2)).toEqual(['release-com-erro', 'auditoria']);
    const auditoria = vi
      .mocked(banco.pool.query)
      .mock.calls.find((c) => normalizar(String(c[0])).startsWith('insert into before_send_traces'));
    expect(auditoria?.[1]).toEqual(expect.arrayContaining(['gate_de_teste', 'codigo_de_teste']));
  });

  it('sem a janela de cópias (enforceSpinning false): a linha vai sem cópia, e o apagar leva só ela', async () => {
    const banco = bancoFalso();
    const r = await runBeforeSend(
      argsDoTurno(banco.pool, async () => ({ kind: 'queued', idempotencyKey: 'k', messageId: null }), {
        enforceSpinning: false,
      }),
    );

    expect(r.status).toBe('sent');
    expect(banco.eventos).not.toContain('registro:outbound_copies');
    expect(banco.eventos.slice(-3)).toEqual(['release', 'apagou:1', 'auditoria']);
    expect(banco.linhas('pacing_ledger')).toEqual([]);
  });

  it('sem a janela de cópias e saída confirmada: só a linha do limite fica', async () => {
    const banco = bancoFalso();

    await runBeforeSend(argsDoTurno(banco.pool, async () => ENVIADA, { enforceSpinning: false }));

    expect(banco.linhas('pacing_ledger')).toHaveLength(1);
    expect(banco.linhas('outbound_copies')).toEqual([]);
  });
});

/**
 * F4q · o envio composto (bolhas, fotos) que saiu EM PARTE. O desfecho é o da última mensagem
 * física: com a 1ª bolha `sent` e a 2ª `failed` ou `queued`, ele não é `sent`, mas a mensagem
 * saiu. `sendInBubbles` e `enviarComFotos` marcam `saiuEmParte`, e a cadeia mantém o registro
 * (`tests/unit/envio-composto-saiu-em-parte.test.ts` prova a marca).
 */
describe('F4q · envio composto: a mensagem que saiu em parte fica no limite do número', () => {
  const DESFECHOS: Record<'failed' | 'queued' | 'blocked' | 'unavailable' | 'already_sent', ChannelSendResult> = {
    failed: { kind: 'failed', idempotencyKey: 'k', messageId: null },
    queued: { kind: 'queued', idempotencyKey: 'k', messageId: null },
    blocked: { kind: 'blocked', idempotencyKey: 'k' },
    unavailable: { kind: 'unavailable', reason: 'sessão caiu entre as bolhas' },
    already_sent: { kind: 'already_sent', idempotencyKey: 'k', messageId: null },
  };

  it.each(Object.keys(DESFECHOS) as (keyof typeof DESFECHOS)[])(
    'desfecho %s com saiuEmParte: a linha e a cópia ficam, e nada é apagado',
    async (kind) => {
      const banco = bancoFalso();
      const desfecho = { ...DESFECHOS[kind], saiuEmParte: true };

      const r = await runBeforeSend(argsDoTurno(banco.pool, async () => desfecho));

      expect(r).toMatchObject({ status: 'sent', outcome: { kind } });
      expect(banco.eventos.filter((e) => e.startsWith('apagou'))).toEqual([]);
      expect(banco.linhas('pacing_ledger')).toHaveLength(1);
      expect(banco.linhas('outbound_copies')).toHaveLength(1);
    },
  );

  function bolhasPeloCanal(kinds: ChannelSendResult['kind'][]): RunBeforeSendArgs['send'] {
    const fila = [...kinds];
    return (corpo) =>
      sendInBubbles(corpo, {
        enabled: true,
        maxChars: 600,
        sleep: async () => {},
        jitter: () => 0,
        send: async () => {
          const kind = fila.shift() ?? 'sent';
          return kind === 'sent' ? ENVIADA : DESFECHOS[kind];
        },
      });
  }

  it.each([
    [['sent', 'failed']],
    [['sent', 'queued']],
  ] as ChannelSendResult['kind'][][][])(
    'de ponta a ponta, com as bolhas %j: a 1ª saiu, e o registro fica',
    async (kinds) => {
      const banco = bancoFalso();

      await runBeforeSend(argsDoTurno(banco.pool, bolhasPeloCanal(kinds), { body: 'Primeira parte.\n\nSegunda parte.' }));

      expect(banco.eventos.filter((e) => e.startsWith('apagou'))).toEqual([]);
      expect(banco.linhas('pacing_ledger')).toHaveLength(1);
    },
  );

  it('controle de ponta a ponta: a 1ª bolha ficou na fila do canal e a 2ª falhou — nada saiu, e o registro é apagado', async () => {
    const banco = bancoFalso();

    await runBeforeSend(
      argsDoTurno(banco.pool, bolhasPeloCanal(['queued', 'failed']), { body: 'Primeira parte.\n\nSegunda parte.' }),
    );

    expect(banco.eventos).toContain('apagou:2');
    expect(banco.linhas('pacing_ledger')).toEqual([]);
  });
});

/**
 * F4q do cxj (Q01) · a organização que para NO MEIO de um envio composto. A 1ª bolha saiu, e a
 * seguinte lança `OrgNaoOperanteError` (o handler barra cada mensagem física): o erro chega
 * marcado (`erroSaiuEmParte`), e a cadeia mantém a linha e a cópia. Sem a marca (nada saiu nesta
 * chamada), ela as apaga, como antes. A marca nas bolhas e nas fotos está provada em
 * `tests/unit/envio-composto-saiu-em-parte.test.ts`; no Postgres real, em
 * `tests/invariants/registro-da-ia-antes-do-envio.test.ts`.
 */
describe('F4q do cxj (Q01) · a organização que para no meio de um envio composto', () => {
  const DUAS_BOLHAS = 'Primeira parte.\n\nSegunda parte.';

  /** As bolhas pelo canal falso, que lança `erro` na chamada `lancarNa` (1 = a 1ª) e manda as outras. */
  function bolhasQueLancamNa(lancarNa: number, erro: unknown): RunBeforeSendArgs['send'] {
    let chamadas = 0;
    return (corpo) =>
      sendInBubbles(corpo, {
        enabled: true,
        maxChars: 600,
        sleep: async () => {},
        jitter: () => 0,
        send: async () => {
          chamadas += 1;
          if (chamadas === lancarNa) throw erro;
          return ENVIADA;
        },
      });
  }

  it.each([false, true])(
    'a 1ª bolha saiu e a 2ª lança (resposta=%s): a linha e a cópia ficam, e o mesmo erro sobe',
    async (resposta) => {
      const banco = bancoFalso();
      const erro = new OrgNaoOperanteError(ORG, 'suspended');

      await expect(
        runBeforeSend(argsDoTurno(banco.pool, bolhasQueLancamNa(2, erro), { resposta, body: DUAS_BOLHAS })),
      ).rejects.toBe(erro);

      expect(banco.eventos.filter((e) => e.startsWith('apagou'))).toEqual([]);
      expect(banco.eventos.at(-1)).toBe('auditoria');
      expect(banco.linhas('pacing_ledger').map((l) => l.params)).toEqual([[ORG, NUMERO, AGORA, resposta]]);
      expect(banco.linhas('outbound_copies')).toHaveLength(1);
    },
  );

  it('o erro da organização que chega marcado, por qualquer envio composto: o registro fica', async () => {
    const banco = bancoFalso();
    const erro = erroComSaidaParcial(new OrgNaoOperanteError(ORG, 'suspended'), true);

    await expect(
      runBeforeSend(
        argsDoTurno(banco.pool, async () => {
          throw erro;
        }),
      ),
    ).rejects.toBe(erro);

    expect(banco.eventos.filter((e) => e.startsWith('apagou'))).toEqual([]);
    expect(banco.linhas('pacing_ledger')).toHaveLength(1);
  });

  it('controle: a 1ª bolha já lança — nada saiu, e a linha e a cópia são apagadas', async () => {
    const banco = bancoFalso();
    const erro = new OrgNaoOperanteError(ORG, 'suspended');

    await expect(
      runBeforeSend(argsDoTurno(banco.pool, bolhasQueLancamNa(1, erro), { body: DUAS_BOLHAS })),
    ).rejects.toBe(erro);

    expect(banco.eventos.slice(-3)).toEqual(['release', 'apagou:2', 'auditoria']);
    expect(banco.linhas('pacing_ledger')).toEqual([]);
    expect(banco.linhas('outbound_copies')).toEqual([]);
  });
});
