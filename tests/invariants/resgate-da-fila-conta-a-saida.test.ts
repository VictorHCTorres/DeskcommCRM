import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { redriveQueued, type WatchdogConfig } from '@/lib/agent-engine/edge/crm/session-reconciler';
import type { Logger } from '@/lib/agent-engine/obs/logger';
import { loadPacingState, recordSend, reservarVaga, type RegraDaVaga } from '@/lib/agent-engine/pacing/store';

/**
 * F4p do cxj (12/11/2026), P07, no Postgres real: a mensagem da IA presa em `queued` que o
 * resgate (`redriveQueued`) manda direto ao WAHA entra no limite do número ANTES de sair.
 *
 * Até a versão 10, o resgate mandava e marcava `sent` sem registro nenhum no `pacing_ledger`: com
 * 59 de 60 no dia, a campanha seguinte liberava a 61ª saída; depois de uma resposta resgatada,
 * passava 1 s depois, com intervalo de 5 s. E uma fila acumulada saía em rajada.
 *
 * Agora o resgate reserva a vaga como a campanha (`reservarVaga`: o teto do dia e o intervalo do
 * número, sob a trava do número) e só então manda. Sem vaga, a mensagem fica na fila para o
 * próximo tique (ou para o job, que a manda pela cadeia). A vaga volta só quando o WAHA recusa
 * com 4xx (nada saiu); erro de rede e 5xx deixam a saída incerta, e a vaga fica.
 *
 * O WAHA é um `fetch` em memória; nenhuma requisição sai do processo.
 */

if (!process.env.TEST_DB_CONTAINER) throw new Error('rode via pnpm test:db');
const pool = new pg.Pool({
  host: '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
  max: 6,
});
afterAll(() => pool.end());
afterEach(async () => {
  vi.restoreAllMocks();
  // O que um caso deixou na fila não pode ser resgatado no caso seguinte.
  await pool.query(`update messages set status = 'failed' where status = 'queued'`);
});

const AGORA = new Date('2026-11-18T14:00:00Z'); // 11h em São Paulo
const REGRA: RegraDaVaga = { limite: 60, desde: new Date('2026-11-18T03:00:00Z'), vagas: 1, intervaloMs: 5_000 };
const CONFIG: WatchdogConfig = {
  wahaBaseUrl: 'http://resgate.invalid',
  wahaApiKey: 'chave-ficticia',
  intervalMs: 1_000,
  redriveMinAgeMs: 0,
  redriveBatchSize: 5,
  redriveSpacingMs: 0,
};

interface Fila {
  org: string;
  numero: string;
  mensagem: string;
}

/**
 * Um número com teto de 60 no CRM, intervalo de 5 s e sem aquecimento, com `disparos` no dia
 * (às 10h) e uma mensagem da IA presa em `queued` há 10 minutos.
 */
async function numeroComFila(opcoes: { disparos?: number; ultimaHaMs?: number; metadata?: object } = {}): Promise<Fila> {
  const org = randomUUID();
  const contato = randomUUID();
  const numero = randomUUID();
  const conversa = randomUUID();
  const mensagem = randomUUID();
  await pool.query(
    `insert into organizations(id,slug,legal_name,display_name,timezone)
     values($1::uuid,$1::text,'Teste P07','Teste P07','America/Sao_Paulo')`,
    [org],
  );
  await pool.query(`insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Contato fictício',$3)`, [
    contato,
    org,
    '+5588' + '9'.repeat(5) + '0707',
  ]);
  await pool.query(
    `insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted,daily_message_limit,metadata)
     values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea,60,$3::jsonb)`,
    [numero, org, JSON.stringify(opcoes.metadata ?? {})],
  );
  await pool.query(
    `insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,warmup_daily_caps)
     values($1,$2,5000,0,$3::jsonb)`,
    [org, numero, JSON.stringify([{ minAgeDays: 0, cap: null }])],
  );
  await pool.query(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [conversa, org, contato, numero],
  );
  const disparos = opcoes.disparos ?? 59;
  for (let i = 0; i < disparos; i++) await recordSend(pool, org, numero, new Date(+AGORA - 3_600_000 + i));
  if (opcoes.ultimaHaMs !== undefined) await recordSend(pool, org, numero, new Date(+AGORA - opcoes.ultimaHaMs));
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,created_at,metadata)
     values($1,$2,$3,$4,$5,'outbound','text','Texto fictício.','queued','ai',now()-interval '10 minutes','{}')`,
    [mensagem, org, conversa, contato, numero],
  );
  return { org, numero, mensagem };
}

function log(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

function resgatar() {
  return redriveQueued(pool, CONFIG, log(), undefined, () => AGORA);
}

function estado(f: Fila) {
  return loadPacingState(pool, f.org, f.numero, { now: AGORA, timezone: 'America/Sao_Paulo', numberActivatedAt: null });
}

async function statusDa(f: Fila): Promise<string> {
  return (await pool.query<{ status: string }>('select status from messages where id = $1', [f.mensagem])).rows[0]!.status;
}

function wahaResponde(status: number) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(JSON.stringify({ id: 'resgate-ficticio' }), { status }));
}

describe('F4p no Postgres real · o resgate da fila conta a saída antes de mandar (P07)', () => {
  it('a mensagem da IA presa sai pelo resgate com a vaga já gravada no limite do número, e a reserva seguinte esbarra no teto', async () => {
    const f = await numeroComFila();
    let disparosNoEnvio: number | undefined;
    const waha = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      disparosNoEnvio = (await estado(f)).sentToday;
      return new Response(JSON.stringify({ id: 'resgate-ficticio' }), { status: 200 });
    });

    expect(await resgatar()).toBe(1);

    expect(waha).toHaveBeenCalledTimes(1);
    expect(disparosNoEnvio).toBe(60);
    expect(await statusDa(f)).toBe('sent');
    const e = await estado(f);
    expect({ hoje: e.sentToday, ultima: e.lastSentAt?.getTime() }).toEqual({ hoje: 60, ultima: AGORA.getTime() });
    expect(await reservarVaga(pool, f.org, f.numero, new Date(+AGORA + 1_000), REGRA)).toBe('teto_cheio');
  });

  it('teto do dia cheio: o resgate não manda, e a mensagem continua na fila', async () => {
    const f = await numeroComFila({ disparos: 60 });
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(60);
  });

  it('intervalo do número: a última saída foi há 1 s (intervalo de 5 s), e o resgate não manda neste tique', async () => {
    const f = await numeroComFila({ disparos: 58, ultimaHaMs: 1_000 });
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('o WAHA recusa a mensagem (422, nada saiu): a vaga volta, e a mensagem continua na fila', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(422);

    expect(await resgatar()).toBe(0);

    expect(waha).toHaveBeenCalledTimes(1);
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it.each([500, 503])('o WAHA responde %i (saída incerta): a vaga fica, e a mensagem continua na fila', async (status) => {
    const f = await numeroComFila();
    wahaResponde(status);

    expect(await resgatar()).toBe(0);

    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(60);
  });

  it('erro de rede no envio (saída incerta): a vaga fica, e a mensagem continua na fila', async () => {
    const f = await numeroComFila();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('conexão encerrada'));

    expect(await resgatar()).toBe(0);

    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(60);
  });

  it('canal pausado: o resgate não reserva vaga nem manda, e a mensagem vira falha', async () => {
    const f = await numeroComFila({ metadata: { disabled: true } });
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('failed');
    expect((await estado(f)).sentToday).toBe(59);
  });
});
