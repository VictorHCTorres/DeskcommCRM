import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { ChannelSendResult } from '@/lib/agent-engine/channel-adapter';
import { pacingGate, runBeforeSend } from '@/lib/agent-engine/guardrails/before-send';
import { loadPacingState, recordSend, reservarVaga, type RegraDaVaga } from '@/lib/agent-engine/pacing/store';

/**
 * F4o do cxj (12/11/2026), O06, no Postgres real: a saída da IA entra na contagem do número
 * antes de acontecer.
 *
 * A contraprova da F4o (ODB05): com 59 de 60 disparos no dia, a cadeia real do agente chamava o
 * transporte, o INSERT do `pacing_ledger` era recusado (trava da tabela, lock_timeout) e o
 * rollback apagava o registro. A reserva seguinte da campanha liberava a 61ª saída; depois de
 * uma resposta da IA, passava em 1 s com intervalo de 5 s.
 *
 * O que este arquivo prova, com a cadeia real (`runBeforeSend` + `pacingGate`), o
 * `reservarVaga` real e o banco recusando de verdade (sem dublê de store nem de banco; o
 * transporte é uma função em memória que conta as saídas):
 * - registro recusado antes do envio: o transporte não é chamado, e a 60ª vaga fica para
 *   quem de fato sai;
 * - commit recusado depois do envio confirmado (gatilho adiado até o commit): o registro é
 *   gravado fora da transação, e a reserva seguinte esbarra no teto ou no intervalo;
 * - transporte que lança depois de aceitar: o registro fica, com ou sem commit recusado;
 * - desfecho em que o canal segurou a mensagem: o registro é desfeito;
 * - enquanto o transporte trabalha, a reserva da campanha espera a trava e, depois, vê a saída.
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
  opcoes: { resposta?: boolean; pool?: pg.Pool; crmDailyLimit?: number | null } = {},
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
    enforceSpinning: false,
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

describe('O06 no Postgres real · a saída da IA entra na contagem do número antes de acontecer', () => {
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
    'commit recusado pelo banco depois do envio confirmado (resposta=%s): o registro sobrevive fora da transação e segura teto e intervalo',
    async (resposta) => {
      const n = await numeroCom59();
      await recusarOPrimeiroCommit(n.numero);
      let saidas = 59;
      const send = vi.fn(async () => {
        saidas++;
        return ENVIADA;
      });

      const { resultado, log } = agente(n, send, { resposta });
      await expect(resultado).rejects.toThrow(/commit recusado de propósito/);

      expect(send).toHaveBeenCalledTimes(1);
      const estado = await estadoDoNumero(n);
      expect(estado.sentToday).toBe(resposta ? 59 : 60);
      expect(estado.lastSentAt?.getTime()).toBe(AGORA.getTime());
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringMatching(/fora da transação/),
        expect.objectContaining({ channel_session_id: n.numero, resposta }),
      );
      const reserva = await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA);
      if (reserva === 'reservada') saidas++;
      expect({ reserva, saidas }).toEqual({ reserva: resposta ? 'intervalo' : 'teto_cheio', saidas: 60 });
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
      const reserva = await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA);
      if (reserva === 'reservada') saidas++;
      expect({ reserva, saidas }).toEqual({ reserva: resposta ? 'intervalo' : 'teto_cheio', saidas: 60 });
    },
  );

  it('transporte que lança e commit recusado: o registro sobrevive fora da transação, e o erro que sobe é o do transporte', async () => {
    const n = await numeroCom59();
    await recusarOPrimeiroCommit(n.numero);
    let saidas = 59;
    const erro = new Error('tempo esgotado no provedor');
    const send = vi.fn(async (): Promise<ChannelSendResult> => {
      saidas++;
      throw erro;
    });

    await expect(agente(n, send).resultado).rejects.toBe(erro);

    expect((await estadoDoNumero(n)).sentToday).toBe(60);
    const reserva = await reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA);
    if (reserva === 'reservada') saidas++;
    expect({ reserva, saidas }).toEqual({ reserva: 'teto_cheio', saidas: 60 });
  });

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

  it('canal segurou a mensagem (queued, nada saiu): o registro feito antes é desfeito e a 60ª vaga continua livre', async () => {
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

  it.each([false, true])(
    'enquanto o transporte trabalha (resposta=%s), a reserva da campanha espera a trava e depois vê a saída',
    async (resposta) => {
      const n = await numeroCom59();
      let entrou!: () => void;
      let liberar!: () => void;
      const entrada = new Promise<void>((ok) => (entrou = ok));
      const portao = new Promise<void>((ok) => (liberar = ok));
      const { resultado } = agente(
        n,
        async () => {
          entrou();
          await portao;
          return ENVIADA;
        },
        { resposta },
      );
      await entrada;
      let terminou = false;
      const reserva = reservarVaga(pool, n.org, n.numero, new Date(+AGORA + 1_000), REGRA).finally(() => {
        terminou = true;
      });
      try {
        await expect
          .poll(
            async () =>
              Number(
                (
                  await pool.query(
                    `select count(*) as n from pg_stat_activity where wait_event = 'advisory' and datname = current_database()`,
                  )
                ).rows[0].n,
              ),
            { timeout: 5_000 },
          )
          .toBeGreaterThan(0);
        expect(terminou).toBe(false);
      } finally {
        liberar();
      }
      expect((await resultado).status).toBe('sent');
      expect(await reserva).toBe(resposta ? 'intervalo' : 'teto_cheio');
      expect((await estadoDoNumero(n)).sentToday).toBe(resposta ? 59 : 60);
    },
  );
});
