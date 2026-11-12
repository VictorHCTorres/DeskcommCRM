import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ChannelSendResult } from '@/lib/agent-engine/channel-adapter';
import { pacingGate, runBeforeSend } from '@/lib/agent-engine/guardrails/before-send';
import {
  loadPacingState,
  recordSend,
  reservarVaga,
  type RegraDaVaga,
  type ReservaDaVaga,
} from '@/lib/agent-engine/pacing/store';

/**
 * F4o e F4p do cxj (12/11/2026), no Postgres real: a saída da IA está no limite do número
 * ANTES de o transporte ser chamado, gravada e confirmada.
 *
 * A F4o (O06) mostrou que o registro feito depois do transporte se perdia num rollback. A
 * versão 10 o pôs antes, mas dentro da mesma transação do envio: se o commit falhasse depois de
 * a mensagem sair, a reserva da campanha que já esperava a trava passava antes de a recuperação
 * gravar (P01); três recusas deixavam só o log (P02); e a auditoria, feita pelo pool com a
 * conexão da cadeia na mão, travava um pool de uma conexão (P05).
 *
 * A versão 11 confirma o registro (linha do limite diário e cópia) numa transação que termina
 * ANTES do transporte, devolve a conexão ao pool e só então manda. O que este arquivo prova, com
 * a cadeia real (`runBeforeSend` + `pacingGate`), o `reservarVaga` real e o banco recusando de
 * verdade (o transporte é uma função em memória que conta as saídas):
 * - registro ou commit recusados: o transporte não é chamado, e a vaga fica para quem sair;
 * - durante o transporte, a reserva da campanha não espera a trava e já vê a saída;
 * - o transporte que lança deixa a saída incerta, e o registro fica;
 * - o desfecho que prova que nada saiu apaga a linha desta tentativa (inclusive a de resposta);
 *   se o banco recusar, ela fica (uma a mais) e o log diz;
 * - a cópia (anti-repetição) segue a linha do limite: gravada antes, apagada junto;
 * - com um pool de uma conexão, o transporte consegue a dele e a auditoria é gravada.
 */

if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const CONEXAO = {
  host: '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
};
const pool = new pg.Pool({ ...CONEXAO, max: 8 });
afterAll(() => pool.end());

const AGORA = new Date('2026-11-18T14:00:00Z'); // 11h em São Paulo
const REGRA: RegraDaVaga = { limite: 60, desde: new Date('2026-11-18T03:00:00Z'), vagas: 1, intervaloMs: 5_000 };
const ENVIADA: ChannelSendResult = { kind: 'sent', idempotencyKey: 'chave-ficticia', messageId: 'mensagem-ficticia' };

interface Numero {
  org: string;
  contato: string;
  numero: string;
  job: string;
}

/** Um número com teto de 60 no CRM, intervalo de 5 s, sem aquecimento e 59 disparos às 10h. */
async function numeroCom59(): Promise<Numero> {
  const org = randomUUID();
  const contato = randomUUID();
  const numero = randomUUID();
  const job = randomUUID();
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name,timezone)
     values($1::uuid,$1::text,'Teste O06','Teste O06','America/Sao_Paulo')`,
    [org],
  );
  await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Contato fictício',$3)`, [
    contato,
    org,
    '+5588' + '9'.repeat(5) + '0606',
  ]);
  await pool.query(
    `insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted,daily_message_limit)
     values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea,60)`,
    [numero, org],
  );
  await pool.query(`insert into job_queue(id,organization_id,contact_id,kind) values($1,$2,$3,'inbound_turn')`, [
    job,
    org,
    contato,
  ]);
  await pool.query(
    `insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,warmup_daily_caps)
     values($1,$2,5000,0,$3::jsonb)`,
    [org, numero, JSON.stringify([{ minAgeDays: 0, cap: null }])],
  );
  for (let i = 0; i < 59; i++) await recordSend(pool, org, numero, new Date(+AGORA - 3_600_000 + i));
  return { org, contato, numero, job };
}

function agente(
  n: Numero,
  send: () => Promise<ChannelSendResult>,
  opcoes: { resposta?: boolean; pool?: pg.Pool; crmDailyLimit?: number | null; enforceSpinning?: boolean } = {},
) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const resultado = runBeforeSend({
    pool: opcoes.pool ?? pool,
    log,
    tenantId: n.org,
    leadId: n.contato,
    jobId: n.job,
    channelSessionId: n.numero,
    body: 'Texto fictício.',
    optedOutThisTurn: false,
    crmDailyLimit: opcoes.crmDailyLimit === undefined ? 60 : opcoes.crmDailyLimit,
    now: AGORA,
    rng: () => 0,
    sleep: async () => {},
    gates: [pacingGate],
    enforceSpinning: opcoes.enforceSpinning ?? false,
    resposta: opcoes.resposta ?? false,
    send,
  });
  return { resultado, log };
}

function estadoDoNumero(n: Numero) {
  return loadPacingState(pool, n.org, n.numero, {
    now: AGORA,
    timezone: 'America/Sao_Paulo',
    numberActivatedAt: null,
  });
}

async function copiasDoNumero(n: Numero): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    'select count(*)::int as n from outbound_copies where organization_id = $1 and channel_session_id = $2',
    [n.org, n.numero],
  );
  return rows[0]!.n;
}

async function auditoriasDoJob(n: Numero): Promise<number> {
  const { rows } = await pool.query<{ n: number }>('select count(*)::int as n from before_send_traces where job_id = $1', [
    n.job,
  ]);
  return rows[0]!.n;
}

/** A promessa, ou um erro com o motivo se ela não andar no prazo (o defeito aqui é pendurar). */
function comPrazo<T>(promessa: Promise<T>, ms: number, motivo: string): Promise<T> {
  let relogio: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<never>((_, recusar) => {
    relogio = setTimeout(() => recusar(new Error(motivo)), ms);
  });
  return Promise.race([promessa, prazo]).finally(() => clearTimeout(relogio));
}

/**
 * Faz o Postgres recusar o PRIMEIRO commit que gravar no limite diário deste número: um gatilho
 * adiado até o commit (`deferrable initially deferred`) lança na 1ª linha. A sequência não volta
 * com o rollback, e a 2ª gravação passa. Cada arquivo de invariante roda num banco próprio.
 */
async function recusarOPrimeiroCommit(numero: string) {
  const nome = `o06_${numero.replace(/-/g, '')}`;
  await pool.query(`create sequence ${nome}_seq`);
  await pool.query(`create function ${nome}() returns trigger language plpgsql as $$
    begin
      if new.channel_session_id = '${numero}'::uuid then
        if nextval('${nome}_seq') = 1 then
          raise exception 'commit recusado de propósito (O06)';
        end if;
      end if;
      return null;
    end $$`);
  await pool.query(
    `create constraint trigger ${nome} after insert on pacing_ledger
       deferrable initially deferred for each row execute function ${nome}()`,
  );
}

/** Faz o Postgres recusar todo DELETE no limite diário deste número. */
async function recusarApagarNoNumero(numero: string) {
  const nome = `f4p_apagar_${numero.replace(/-/g, '')}`;
  await pool.query(`create function ${nome}() returns trigger language plpgsql as $$
    begin
      if old.channel_session_id = '${numero}'::uuid then
        raise exception 'apagar recusado de propósito (F4p)';
      end if;
      return old;
    end $$`);
  await pool.query(`create trigger ${nome} before delete on pacing_ledger for each row execute function ${nome}()`);
}

describe('F4o/F4p no Postgres real · a saída da IA está no limite do número antes do transporte', () => {
  it.each([false, true])(
    'registro recusado pelo banco (resposta=%s): o transporte não é chamado, e a 60ª vaga fica para quem de fato sai',
    async (resposta) => {
      const n = await numeroCom59();
      const poolDoAgente = new pg.Pool({ ...CONEXAO, max: 4, options: '-c lock_timeout=200ms' });
      const bloqueador = await pool.connect();
      let saidas = 59;
      const send = vi.fn(async () => {
        saidas++;
        return ENVIADA;
      });
      try {
        await bloqueador.query('begin');
        await bloqueador.query('lock table pacing_ledger in share mode');
        await expect(agente(n, send, { resposta, pool: poolDoAgente }).resultado).rejects.toMatchObject({
          code: '55P03',
        });
      } finally {
        await bloqueador.query('rollback');
        bloqueador.release();
        await poolDoAgente.end();
      }

      expect(send).not.toHaveBeenCalled();
      expect((await estadoDoNumero(n)).sentToday).toBe(59);
      // O oráculo da F4o: a falha da contagem não libera saída a mais. Nada saiu; a 60ª vaga
      // é de quem sair agora, e a seguinte já esbarra no teto.
      const reserva = await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA);
      if (reserva === 'reservada') saidas++;
      expect({ reserva, saidas }).toEqual({ reserva: 'reservada', saidas: 60 });
      expect(await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 60_000), REGRA)).toBe('teto_cheio');
    },
  );

  it.each([false, true])(
    'commit do registro recusado (F4p, P01 e P02; resposta=%s): o transporte não é chamado, e a vaga continua de quem sair',
    async (resposta) => {
      const n = await numeroCom59();
      await recusarOPrimeiroCommit(n.numero);
      let saidas = 59;
      const send = vi.fn(async () => {
        saidas++;
        return ENVIADA;
      });

      await expect(agente(n, send, { resposta }).resultado).rejects.toThrow(/commit recusado de propósito/);

      expect(send).not.toHaveBeenCalled();
      const estado = await estadoDoNumero(n);
      expect(estado.sentToday).toBe(59);
      expect(estado.lastSentAt?.getTime()).toBeLessThan(AGORA.getTime());
      // A tentativa que errou deixa a auditoria, gravada depois de a conexão voltar ao pool.
      expect(await auditoriasDoJob(n)).toBe(1);
      // Nada saiu: a reserva seguinte é legítima, e a outra já esbarra no teto.
      const reserva = await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA);
      if (reserva === 'reservada') saidas++;
      expect({ reserva, saidas }).toEqual({ reserva: 'reservada', saidas: 60 });
      expect(await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 60_000), REGRA)).toBe('teto_cheio');
    },
  );

  it.each([false, true])(
    'enquanto o transporte trabalha (F4p, P01; resposta=%s), o registro já está confirmado: a reserva da campanha não espera a trava e esbarra no teto ou no intervalo',
    async (resposta) => {
      const n = await numeroCom59();
      let reservaDuranteOEnvio: ReservaDaVaga | Error | undefined;
      const { resultado } = agente(
        n,
        async () => {
          reservaDuranteOEnvio = await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), {
            ...REGRA,
            esperaMs: 1_000,
          }).catch((erro: Error) => erro);
          return ENVIADA;
        },
        { resposta },
      );

      expect((await resultado).status).toBe('sent');
      expect(reservaDuranteOEnvio).toBe(resposta ? 'intervalo' : 'teto_cheio');
      expect((await estadoDoNumero(n)).sentToday).toBe(resposta ? 59 : 60);
    },
  );

  it.each([false, true])(
    'transporte que lança depois de aceitar (resposta=%s): o registro fica e segura teto e intervalo',
    async (resposta) => {
      const n = await numeroCom59();
      let saidas = 59;
      const erro = new Error('o provedor aceitou e a gravação do aceite falhou');
      const send = vi.fn(async (): Promise<ChannelSendResult> => {
        saidas++;
        throw erro;
      });

      await expect(agente(n, send, { resposta }).resultado).rejects.toBe(erro);

      expect((await estadoDoNumero(n)).sentToday).toBe(resposta ? 59 : 60);
      expect(await auditoriasDoJob(n)).toBe(1);
      const reserva = await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA);
      if (reserva === 'reservada') saidas++;
      expect({ reserva, saidas }).toEqual({ reserva: resposta ? 'intervalo' : 'teto_cheio', saidas: 60 });
    },
  );

  it('O07 · follow-up sem o teto do CRM (null), aquecimento de 200: a cadeia lê os 60 do número e veta o 61º', async () => {
    const n = await numeroCom59();
    await pool.query(`update job_queue set kind = 'followup_turn' where id = $1`, [n.job]);
    // O aquecimento do chip de 19 dias (200 por dia) não segura: quem segura são os 60 do CRM.
    await pool.query(`update channel_knobs set warmup_daily_caps = $2::jsonb where channel_session_id = $1`, [
      n.numero,
      JSON.stringify([{ minAgeDays: 0, cap: 200 }]),
    ]);
    expect(await reservarVaga(pool, n.org, n.numero, AGORA, REGRA)).toBe('reservada');
    const send = vi.fn(async () => ENVIADA);

    const r = await agente(n, send, { crmDailyLimit: null }).resultado;

    expect({ status: r.status, saidas: send.mock.calls.length, ledger: (await estadoDoNumero(n)).sentToday }).toEqual({
      status: 'vetoed',
      saidas: 0,
      ledger: 60,
    });
    expect(r).toMatchObject({ code: 'daily_cap' });
  });

  it('canal segurou a mensagem (queued, nada saiu): o registro feito antes é apagado e a 60ª vaga continua livre', async () => {
    const n = await numeroCom59();
    const send = vi.fn(
      async (): Promise<ChannelSendResult> => ({ kind: 'queued', idempotencyKey: 'chave-ficticia', messageId: null }),
    );

    const r = await agente(n, send).resultado;

    expect(r.status).toBe('sent');
    expect(send).toHaveBeenCalledTimes(1);
    expect((await estadoDoNumero(n)).sentToday).toBe(59);
    expect(await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA)).toBe('reservada');
  });

  it.each([
    { kind: 'already_sent', idempotencyKey: 'chave-ficticia', messageId: null },
    { kind: 'failed', idempotencyKey: 'chave-ficticia', messageId: null },
    { kind: 'blocked', idempotencyKey: 'chave-ficticia' },
    { kind: 'unavailable', reason: 'transporte fora' },
  ] satisfies ChannelSendResult[])(
    'resposta da IA com desfecho que prova que nada saiu ($kind): a linha desta tentativa é apagada, e o intervalo volta a contar da saída anterior',
    async (desfecho) => {
      const n = await numeroCom59();
      const antes = (await estadoDoNumero(n)).lastSentAt?.getTime();

      const r = await agente(n, async () => desfecho, { resposta: true }).resultado;

      expect(r).toMatchObject({ status: 'sent', outcome: { kind: desfecho.kind } });
      const estado = await estadoDoNumero(n);
      expect({ hoje: estado.sentToday, ultima: estado.lastSentAt?.getTime() }).toEqual({ hoje: 59, ultima: antes });
      expect(await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA)).toBe('reservada');
    },
  );

  it('apagar recusado pelo banco: a saída que não aconteceu segue contada (uma a mais), o resultado volta e o log diz', async () => {
    const n = await numeroCom59();
    await recusarApagarNoNumero(n.numero);
    const send = vi.fn(
      async (): Promise<ChannelSendResult> => ({ kind: 'failed', idempotencyKey: 'chave-ficticia', messageId: null }),
    );

    const { resultado, log } = agente(n, send);
    const r = await resultado;

    expect(r).toMatchObject({ status: 'sent', outcome: { kind: 'failed' } });
    expect((await estadoDoNumero(n)).sentToday).toBe(60);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringMatching(/não foi apagado/),
      expect.objectContaining({ channel_session_id: n.numero, sent_at: AGORA.toISOString(), desfecho: 'failed' }),
    );
  });

  it('com a janela de cópias: a cópia é confirmada com o registro antes do transporte e apagada quando nada saiu', async () => {
    const n = await numeroCom59();
    let copiasNoEnvio: number | undefined;
    const r = await agente(
      n,
      async (): Promise<ChannelSendResult> => {
        copiasNoEnvio = await copiasDoNumero(n);
        return { kind: 'failed', idempotencyKey: 'chave-ficticia', messageId: null };
      },
      { enforceSpinning: true },
    ).resultado;

    expect(r).toMatchObject({ status: 'sent', outcome: { kind: 'failed' } });
    expect({ copiasNoEnvio, copiasDepois: await copiasDoNumero(n) }).toEqual({ copiasNoEnvio: 1, copiasDepois: 0 });
  });

  it('com a janela de cópias e a saída confirmada: a linha do limite e a cópia ficam', async () => {
    const n = await numeroCom59();

    const r = await agente(n, async () => ENVIADA, { enforceSpinning: true }).resultado;

    expect(r.status).toBe('sent');
    expect({ hoje: (await estadoDoNumero(n)).sentToday, copias: await copiasDoNumero(n) }).toEqual({ hoje: 60, copias: 1 });
  });

  it('pool de uma conexão (F4p, P05): o transporte consegue a dele, e a auditoria é gravada', async () => {
    const n = await numeroCom59();
    const poolDeUm = new pg.Pool({ ...CONEXAO, max: 1 });
    try {
      const { resultado } = agente(
        n,
        async () => {
          // O handler de produção grava `send_ledger` e `messages` pelo pool: precisa de uma conexão.
          await comPrazo(poolDeUm.query('select 1'), 2_000, 'o transporte esperou a conexão que a cadeia segurava');
          return ENVIADA;
        },
        { pool: poolDeUm },
      );

      const r = await comPrazo(resultado, 6_000, 'a cadeia não terminou com um pool de uma conexão');

      expect(r.status).toBe('sent');
      expect((await estadoDoNumero(n)).sentToday).toBe(60);
      expect(await auditoriasDoJob(n)).toBe(1);
    } finally {
      await comPrazo(poolDeUm.end(), 2_000, 'pool preso').catch(() => undefined);
    }
  });

  it('veto com um pool de uma conexão (F4p, P05): a auditoria do veto é gravada depois de a cadeia devolver a conexão', async () => {
    const n = await numeroCom59();
    // O 60º disparo do dia: o próximo esbarra no teto do CRM.
    await recordSend(pool, n.org, n.numero, new Date(+AGORA - 3_000_000));
    const poolDeUm = new pg.Pool({ ...CONEXAO, max: 1 });
    const send = vi.fn(async () => ENVIADA);
    try {
      const r = await comPrazo(
        agente(n, send, { pool: poolDeUm }).resultado,
        6_000,
        'a cadeia não terminou o veto com um pool de uma conexão',
      );

      expect(r).toMatchObject({ status: 'vetoed', code: 'daily_cap' });
      expect(send).not.toHaveBeenCalled();
      const { rows } = await pool.query<{ n: number }>(
        `select count(*)::int as n from before_send_traces where job_id = $1 and vetoed_code = 'daily_cap'`,
        [n.job],
      );
      expect(rows[0]!.n).toBe(1);
    } finally {
      await comPrazo(poolDeUm.end(), 2_000, 'pool preso').catch(() => undefined);
    }
  });
});
