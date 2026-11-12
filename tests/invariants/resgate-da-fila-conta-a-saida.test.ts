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
 * próximo tique. A vaga volta só quando o WAHA recusa com 4xx (nada saiu); erro de rede e 5xx
 * deixam a saída incerta, e a vaga fica.
 *
 * F4q do cxj (Q08 e Q03), versão 12: a resposta presa (o job da chave dela é um turno de
 * resposta) reserva como resposta — conta no intervalo e não gasta o teto do dia, e não espera o
 * dia seguinte com o teto batido; o turno de entrada não a reagenda, e o resgate é o único
 * caminho dela. E o que muda enquanto o resgate espera a vaga (o processo desligando, o canal
 * pausado, o modo de teste, a sessão fora do ar, o contato bloqueado) vale: a conferência roda de
 * novo depois da reserva, e a vaga volta.
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
async function numeroComFila(
  opcoes: { disparos?: number; ultimaHaMs?: number; metadata?: object; origem?: string } = {},
): Promise<Fila> {
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
     values($1,$2,$3,$4,$5,'outbound','text','Texto fictício.','queued','ai',now()-interval '10 minutes',$6::jsonb)`,
    [mensagem, org, conversa, contato, numero, JSON.stringify(opcoes.origem ? { idempotency_key: mensagem } : {})],
  );
  if (opcoes.origem) {
    // Como o envio do agente grava (`sendTurnMessage` → `sendWithLedger`): a linha do
    // `send_ledger` tem o id da mensagem (`internalMessageId`) e o job do turno que a mandou.
    const job = randomUUID();
    await pool.query(`insert into job_queue(id,organization_id,contact_id,kind) values($1,$2,$3,$4)`, [
      job,
      org,
      contato,
      opcoes.origem,
    ]);
    await pool.query(
      `insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
       values($1,$2,$3,$4,1,'hash-ficticio','queued',$1)`,
      [mensagem, org, contato, job],
    );
  }
  return { org, numero, mensagem };
}

/** As linhas de RESPOSTA do número naquele instante (a resposta não entra em `sentToday`). */
async function respostasEm(f: Fila, quando: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from pacing_ledger
      where organization_id = $1 and channel_session_id = $2 and sent_at = $3 and resposta`,
    [f.org, f.numero, quando],
  );
  return Number(rows[0]!.n);
}

/** Uma porta: quem espera nela só passa quando o teste a abre. */
function porta() {
  let abrir!: () => void;
  const aberta = new Promise<void>((resolve) => {
    abrir = resolve;
  });
  return { abrir, aberta };
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

/**
 * F4q do cxj (12/11/2026), Q08: a mensagem presa pode ser uma RESPOSTA. O turno de entrada (ou o
 * do caso, ou a resposta aprovada) respondeu a quem escreveu, e o canal a segurou (`queued`). Na
 * cadeia, a resposta não gasta o teto do dia e conta só no intervalo; o turno aceita o `queued` e
 * termina, e quem a entrega é o resgate. Na versão 11 o resgate a contava como disparo: com o teto
 * cheio, a resposta de quem escreveu ficava na fila até o dia seguinte. Agora o resgate a reconhece
 * pelo job de origem (`send_ledger.job_id`, o mesmo critério da cadeia) e a reserva como resposta.
 */
describe('F4q no Postgres real · a resposta presa sai pelo resgate como resposta (Q08)', () => {
  it.each(['inbound_turn', 'case_reply_turn', 'approved_reply'])(
    'teto do dia cheio, e a presa é a resposta de um job %s: o resgate a manda, e a vaga é de resposta',
    async (origem) => {
      const f = await numeroComFila({ disparos: 60, origem });
      const waha = wahaResponde(200);

      expect(await resgatar()).toBe(1);

      expect(waha).toHaveBeenCalledTimes(1);
      expect(await statusDa(f)).toBe('sent');
      expect((await estado(f)).sentToday).toBe(60);
      expect(await respostasEm(f, AGORA)).toBe(1);
      // A resposta conta no intervalo: a reserva seguinte, 1 s depois, esbarra nele.
      expect(await reservarVaga(pool, f.org, f.numero, new Date(+AGORA + 1_000), { ...REGRA, limite: null })).toBe(
        'intervalo',
      );
    },
  );

  it('controle: a presa de um follow-up (disparo) com o teto cheio não sai, e fica na fila', async () => {
    const f = await numeroComFila({ disparos: 60, origem: 'followup_turn' });
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect(await respostasEm(f, AGORA)).toBe(0);
  });

  it('controle: a presa sem o job de origem conta como disparo (o lado seguro)', async () => {
    const f = await numeroComFila({ disparos: 60 });
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
  });

  it('controle: a resposta já entregue ao mesmo contato não faz do follow-up preso uma resposta (a ligação é pela chave da presa)', async () => {
    const f = await numeroComFila({ disparos: 60, origem: 'followup_turn' });
    // Antes do follow-up, o turno de entrada respondeu ao mesmo contato, e a resposta saiu: a linha
    // dela no `send_ledger` tem a chave (o id) da mensagem entregue e o job do turno de entrada.
    const entregue = randomUUID();
    const turno = randomUUID();
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,created_at,metadata)
       select $1::uuid, organization_id, conversation_id, contact_id, channel_session_id, 'outbound', 'text', 'Resposta fictícia.',
              'sent', 'ai', now() - interval '30 minutes', jsonb_build_object('idempotency_key', $1::uuid::text)
         from messages where id = $2`,
      [entregue, f.mensagem],
    );
    await pool.query(
      `insert into job_queue(id,organization_id,contact_id,kind)
       select $1, organization_id, contact_id, 'inbound_turn' from messages where id = $2`,
      [turno, entregue],
    );
    await pool.query(
      `insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
       select id, organization_id, contact_id, $2, 1, 'hash-ficticio', 'accepted', id from messages where id = $1`,
      [entregue, turno],
    );
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect(await respostasEm(f, AGORA)).toBe(0);
  });

  it('a resposta presa respeita o intervalo do número: a última saída foi há 1 s, e ela não sai neste tique', async () => {
    const f = await numeroComFila({ disparos: 58, ultimaHaMs: 1_000, origem: 'inbound_turn' });
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect(await respostasEm(f, AGORA)).toBe(0);
  });

  it('o WAHA recusa a resposta presa (422, nada saiu): a vaga de resposta volta, e a mensagem continua na fila', async () => {
    const f = await numeroComFila({ disparos: 60, origem: 'inbound_turn' });
    const waha = wahaResponde(422);

    expect(await resgatar()).toBe(0);

    expect(waha).toHaveBeenCalledTimes(1);
    expect(await statusDa(f)).toBe('queued');
    expect(await respostasEm(f, AGORA)).toBe(0);
    expect((await estado(f)).sentToday).toBe(60);
  });

  it('o WAHA responde 503 à resposta presa (saída incerta): a vaga de resposta fica', async () => {
    const f = await numeroComFila({ disparos: 60, origem: 'inbound_turn' });
    wahaResponde(503);

    expect(await resgatar()).toBe(0);

    expect(await statusDa(f)).toBe('queued');
    expect(await respostasEm(f, AGORA)).toBe(1);
  });
});

/**
 * F4q do cxj (12/11/2026), Q03: a reserva da vaga pega uma conexão do pool, que espera sem prazo
 * (`db/pool.ts`). A conferência da mensagem (o desligamento, a organização, a pausa do canal, o
 * modo de teste, a campanha) vinha ANTES dessa espera, e o transporte DEPOIS, sem conferir de
 * novo: o canal pausado, ou o processo de saída, enquanto o resgate esperava a conexão, não
 * impedia o envio. Agora a conferência se repete depois da reserva, logo antes do transporte, e
 * a vaga reservada volta quando a mensagem não sai. Ela relê também o que a consulta do resgate
 * filtra (a sessão no ar e o contato não bloqueado): o bloqueio, que é o veto permanente do
 * contato, e a queda da sessão, durante a espera, também barram o envio.
 */
describe('F4q no Postgres real · o que muda enquanto o resgate espera a vaga vale (Q03)', () => {
  /** O pool de verdade, com a conexão da reserva presa numa porta que o teste abre. */
  function poolComEspera() {
    const chegou = porta();
    const soltar = porta();
    const fachada = {
      query: pool.query.bind(pool),
      connect: async () => {
        chegou.abrir();
        await soltar.aberta;
        return pool.connect();
      },
    } as unknown as pg.Pool;
    return { fachada, chegou, soltar };
  }

  it('o processo é desligado (abort) enquanto o resgate espera a vaga: nada sai, a vaga volta, e a mensagem fica na fila', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(200);
    const desligamento = new AbortController();
    const { fachada, chegou, soltar } = poolComEspera();

    const resgate = redriveQueued(fachada, CONFIG, log(), desligamento.signal, () => AGORA);
    await chegou.aberta;
    desligamento.abort();
    soltar.abrir();

    expect(await resgate).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('o canal é pausado enquanto o resgate espera a vaga: nada sai, a vaga volta, e a mensagem vira falha', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(200);
    const { fachada, chegou, soltar } = poolComEspera();

    const resgate = redriveQueued(fachada, CONFIG, log(), undefined, () => AGORA);
    await chegou.aberta;
    await pool.query(`update channel_sessions set metadata = '{"disabled":true}'::jsonb where id = $1`, [f.numero]);
    soltar.abrir();

    expect(await resgate).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('failed');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('o modo de teste é ligado enquanto o resgate espera a vaga: nada sai, e a vaga volta', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(200);
    const { fachada, chegou, soltar } = poolComEspera();

    const resgate = redriveQueued(fachada, CONFIG, log(), undefined, () => AGORA);
    await chegou.aberta;
    await pool.query(
      `update channel_sessions
          set metadata = '{"ai_gate":"allowlist","ai_gate_mode":"pre_go_live","ai_test_phone_numbers":[]}'::jsonb
        where id = $1`,
      [f.numero],
    );
    soltar.abrir();

    expect(await resgate).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('failed');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('o contato é bloqueado enquanto o resgate espera a vaga: nada sai, a vaga volta, e a mensagem fica como o bloqueio a deixa', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(200);
    const { fachada, chegou, soltar } = poolComEspera();

    const resgate = redriveQueued(fachada, CONFIG, log(), undefined, () => AGORA);
    await chegou.aberta;
    // O bloqueio é o veto permanente do contato (`send_ledger`, status `vetoed`): a consulta do
    // resgate já não traz quem está bloqueado, e a mensagem dele fica parada na fila.
    await pool.query(
      `update contacts set is_blocked = true where id = (select contact_id from messages where id = $1)`,
      [f.mensagem],
    );
    soltar.abrir();

    expect(await resgate).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('a sessão do número sai do ar enquanto o resgate espera a vaga: nada sai, a vaga volta, e a mensagem fica na fila', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(200);
    const { fachada, chegou, soltar } = poolComEspera();

    const resgate = redriveQueued(fachada, CONFIG, log(), undefined, () => AGORA);
    await chegou.aberta;
    await pool.query(`update channel_sessions set status = 'SCAN_QR_CODE' where id = $1`, [f.numero]);
    soltar.abrir();

    expect(await resgate).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('controle: nada muda durante a espera, e a mensagem sai com a vaga gravada', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(200);
    const { fachada, chegou, soltar } = poolComEspera();

    const resgate = redriveQueued(fachada, CONFIG, log(), undefined, () => AGORA);
    await chegou.aberta;
    soltar.abrir();

    expect(await resgate).toBe(1);
    expect(waha).toHaveBeenCalledTimes(1);
    expect(await statusDa(f)).toBe('sent');
    expect((await estado(f)).sentToday).toBe(60);
  });
});
