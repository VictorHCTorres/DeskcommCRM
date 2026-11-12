import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { pgSendLedger, sendWithLedger } from '@/lib/agent-engine/edge/crm/send-ledger';
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
const CONEXAO = {
  host: '127.0.0.1',
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: 'postgres',
  password: 'postgres',
  database: 'postgres',
};
const pool = new pg.Pool({ ...CONEXAO, max: 6 });
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
  contato: string;
  /** O job da chave da mensagem (`origem`); `null` sem ele. */
  job: string | null;
}

/**
 * Um número com teto de 60 no CRM, intervalo de 5 s e sem aquecimento, com `disparos` no dia
 * (às 10h) e uma mensagem da IA presa em `queued` há 10 minutos.
 *
 * Com `origem`, a mensagem tem a chave do `send_ledger` de um job desse tipo. O job termina
 * (`done`) por padrão, como o turno que aceita o `queued` e acaba (F4q do cxj, Q08): a mensagem
 * fica sem dono, e é do resgate. `jobVivo` o deixa pendente (o follow-up reagendado) ou em
 * execução: aí a mensagem tem dono, e o resgate não a toca (F4r do cxj, R08). `sentVia` muda
 * quem mandou (a IA, por padrão).
 */
async function numeroComFila(
  opcoes: {
    disparos?: number;
    ultimaHaMs?: number;
    metadata?: object;
    origem?: string;
    jobVivo?: 'pending' | 'running';
    janela?: { disparo: [number, number]; resposta: [number, number] };
    sentVia?: 'ai' | 'automation' | 'system';
  } = {},
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
    `insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,warmup_daily_caps,
                               window_start_hour,window_end_hour,resposta_start_hour,resposta_end_hour)
     values($1,$2,5000,0,$3::jsonb,$4,$5,$6,$7)`,
    [
      org,
      numero,
      JSON.stringify([{ minAgeDays: 0, cap: null }]),
      opcoes.janela?.disparo[0] ?? null,
      opcoes.janela?.disparo[1] ?? null,
      opcoes.janela?.resposta[0] ?? null,
      opcoes.janela?.resposta[1] ?? null,
    ],
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
     values($1,$2,$3,$4,$5,'outbound','text','Texto fictício.','queued',$7,now()-interval '10 minutes',$6::jsonb)`,
    [
      mensagem,
      org,
      conversa,
      contato,
      numero,
      JSON.stringify(opcoes.origem ? { idempotency_key: mensagem } : {}),
      opcoes.sentVia ?? 'ai',
    ],
  );
  let job: string | null = null;
  if (opcoes.origem) {
    // Como o envio do agente grava (`sendTurnMessage` → `sendWithLedger`): a linha do
    // `send_ledger` tem o id da mensagem (`internalMessageId`) e o job do turno que a mandou.
    job = randomUUID();
    const status = opcoes.jobVivo ?? 'done';
    await pool.query(
      `insert into job_queue(id,organization_id,contact_id,kind,status,locked_by,locked_at)
       values($1,$2,$3,$4,$5,$6,$7)`,
      [
        job,
        org,
        contato,
        opcoes.origem,
        status,
        status === 'running' ? 'worker-ficticio' : null,
        status === 'running' ? new Date() : null,
      ],
    );
    await pool.query(
      `insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
       values($1,$2,$3,$4,1,'hash-ficticio','queued',$1)`,
      [mensagem, org, contato, job],
    );
  }
  return { org, numero, mensagem, contato, job };
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

function resgatar(quando: Date = AGORA) {
  return redriveQueued(pool, CONFIG, log(), undefined, () => quando);
}

/** As linhas do número naquele instante, de disparo ou de resposta. */
async function vagasEm(f: Fila, quando: Date): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from pacing_ledger
      where organization_id = $1 and channel_session_id = $2 and sent_at = $3`,
    [f.org, f.numero, quando],
  );
  return Number(rows[0]!.n);
}

async function falhaDa(f: Fila): Promise<{ status: string; error_code: string | null }> {
  return (
    await pool.query<{ status: string; error_code: string | null }>(
      'select status, error_code from messages where id = $1',
      [f.mensagem],
    )
  ).rows[0]!;
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

/**
 * Mais uma mensagem da IA presa no mesmo número e na mesma conversa de `f`, criada há `haMinutos`,
 * com a chave de um job `origem` (terminado por padrão, ou `jobVivo`). Devolve a fila dela.
 */
async function maisUmaPresa(
  f: Fila,
  opcoes: { origem: string; jobVivo?: 'pending' | 'running'; haMinutos: number },
): Promise<Fila> {
  const mensagem = randomUUID();
  const job = randomUUID();
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,created_at,metadata)
     select $1,organization_id,conversation_id,contact_id,channel_session_id,'outbound','text','Texto fictício.','queued','ai',
            now() - make_interval(mins => $3),$4::jsonb
       from messages where id = $2`,
    [mensagem, f.mensagem, opcoes.haMinutos, JSON.stringify({ idempotency_key: mensagem })],
  );
  const status = opcoes.jobVivo ?? 'done';
  await pool.query(
    `insert into job_queue(id,organization_id,contact_id,kind,status,locked_by,locked_at)
     values($1,$2,$3,$4,$5,$6,$7)`,
    [
      job,
      f.org,
      f.contato,
      opcoes.origem,
      status,
      status === 'running' ? 'worker-ficticio' : null,
      status === 'running' ? new Date() : null,
    ],
  );
  await pool.query(
    `insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id)
     values($1,$2,$3,$4,1,'hash-ficticio','queued',$1)`,
    [mensagem, f.org, f.contato, job],
  );
  return { ...f, mensagem, job };
}

/**
 * Espera até alguém esperar a trava do número (`pg_advisory_xact_lock(hashtext(numero))`, que o
 * Postgres guarda com os 32 bits de cima da chave em `classid` e os de baixo em `objid`).
 */
async function alguemEsperaATravaDo(numero: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const { rows } = await pool.query<{ n: string }>(
      `select count(*)::text as n from pg_locks
        where locktype = 'advisory' and not granted and objsubid = 1
          and classid = ((hashtext($1)::bigint >> 32) & 4294967295)::oid
          and objid = (hashtext($1)::bigint & 4294967295)::oid`,
      [numero],
    );
    if (Number(rows[0]!.n) > 0) return;
    await new Promise((pronto) => setTimeout(pronto, 10));
  }
  throw new Error('ninguém chegou à trava do número em 5 s');
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

/** O resgate com a reserva presa na porta, e `mudar` aplicado durante a espera. */
async function resgatarMudandoNaEspera(mudar: () => Promise<unknown>, quando: Date = AGORA): Promise<number> {
  const { fachada, chegou, soltar } = poolComEspera();
  const resgate = redriveQueued(fachada, CONFIG, log(), undefined, () => quando);
  try {
    await chegou.aberta;
    await mudar();
  } finally {
    soltar.abrir();
  }
  return resgate;
}

describe('F4q no Postgres real · o que muda enquanto o resgate espera a vaga vale (Q03)', () => {
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

/**
 * F4r do cxj (12/11/2026), R08: a mensagem presa tinha dois donos. O job que a mandou (o follow-up
 * reagendado, ou o job que volta à fila quando o worker morre) a manda de novo pela cadeia, com a
 * mesma chave, e o resgate a reenviava direto ao WAHA. Os dois liam `queued`, e ela saía duas
 * vezes. Agora o resgate só toca a mensagem cujo job terminou (`done`, `failed` ou `dead`) ou que
 * não tem job: a de job vivo é do job, que a reavalia pela cadeia, com todos os portões.
 */
describe('F4r no Postgres real · a mensagem presa tem um dono só (R08)', () => {
  it.each(['pending', 'running'] as const)(
    'o job da mensagem ainda está vivo (%s): o resgate não a toca nem reserva vaga',
    async (jobVivo) => {
      const f = await numeroComFila({ origem: 'followup_turn', jobVivo });
      const waha = wahaResponde(200);

      expect(await resgatar()).toBe(0);

      expect(waha).not.toHaveBeenCalled();
      expect(await statusDa(f)).toBe('queued');
      expect(await vagasEm(f, AGORA)).toBe(0);
    },
  );

  it('o job volta à fila enquanto o resgate espera a vaga: nada sai, a vaga volta, e a mensagem fica para o job', async () => {
    const f = await numeroComFila({ origem: 'followup_turn' });
    const waha = wahaResponde(200);

    // O código não devolve à fila um job terminado; o operador pode (à mão, no banco). A releitura
    // confere o que a consulta do resgate confere (F4q do cxj, Q03): com o job vivo outra vez, a
    // mensagem é dele, e a vaga reservada volta.
    const n = await resgatarMudandoNaEspera(() =>
      pool.query(`update job_queue set status = 'pending' where id = $1`, [f.job]),
    );

    expect(n).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect(await vagasEm(f, AGORA)).toBe(0);
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('o job vivo segura só a mensagem dele: a outra presa do mesmo número, de job terminado, sai', async () => {
    const f = await numeroComFila({ origem: 'followup_turn', jobVivo: 'pending' });
    const livre = await maisUmaPresa(f, { origem: 'followup_turn', haMinutos: 5 });
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(1);

    expect(waha).toHaveBeenCalledTimes(1);
    expect(await statusDa(livre)).toBe('sent');
    expect(await statusDa(f)).toBe('queued');
  });

  it('as presas de job vivo não ocupam o lote: atrás de 5 delas (o lote é de 5), a presa sem dono sai no mesmo tique', async () => {
    // O follow-up adiado pela janela fica pendente por horas: se as mensagens dele entrassem no
    // lote, cada tique gastaria o lote com elas, e a presa de trás nunca sairia.
    const f = await numeroComFila({ origem: 'followup_turn', jobVivo: 'pending' });
    for (let i = 0; i < CONFIG.redriveBatchSize - 1; i++) {
      await maisUmaPresa(f, { origem: 'followup_turn', jobVivo: 'pending', haMinutos: 9 });
    }
    const livre = await maisUmaPresa(f, { origem: 'followup_turn', haMinutos: 5 });
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(1);

    expect(waha).toHaveBeenCalledTimes(1);
    expect(await statusDa(livre)).toBe('sent');
    expect(await statusDa(f)).toBe('queued');
  });

  it('a nova tentativa do job vivo e o resgate, no mesmo instante: a mensagem sai uma vez só', async () => {
    const f = await numeroComFila({ origem: 'inbound_turn', jobVivo: 'pending' });
    let entregas = 0;
    const entrou = porta();
    const soltar = porta();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      entregas += 1;
      entrou.abrir();
      await soltar.aberta;
      return new Response(JSON.stringify({ id: 'resgate-ficticio' }), { status: 200 });
    });

    const resgate = redriveQueued(pool, CONFIG, log(), undefined, () => AGORA);
    // Se o resgate pega a mensagem, ele fica em voo no transporte; se não pega, termina antes.
    await Promise.race([entrou.aberta, resgate]);
    try {
      // A nova tentativa do job, pela chave real (`sendWithLedger` sobre o `send_ledger`), com o
      // handler em memória: ela acha a mensagem em `queued` e a manda, como a cadeia manda.
      const tentativa = await sendWithLedger(
        pgSendLedger(pool),
        { tenantId: f.org, leadId: f.contato, jobId: f.job!, seq: 1, body: 'Texto fictício.' },
        async (_chave, id) => {
          entregas += 1;
          await pool.query(`update messages set status = 'sent' where id = $1`, [id]);
          return { id, status: 'sent' };
        },
      );
      expect(tentativa.kind).toBe('sent');
    } finally {
      soltar.abrir();
    }
    await resgate;

    expect(entregas).toBe(1);
  });
});

/**
 * F4r do cxj (12/11/2026), R05: o resgate lia o limite diário do CRM e os knobs do número antes de
 * esperar a trava, e a reserva conferia a vaga com o que tinha lido. O operador que baixava o
 * limite durante a espera não era ouvido: com 59 de 60 e o limite baixado para 59, a 60ª saía.
 * Agora a regra da vaga (o limite do CRM, o aquecimento, o intervalo, o dia e a janela) é lida
 * sob a trava do número, dentro da transação da reserva.
 */
describe('F4r no Postgres real · a regra da vaga é lida sob a trava (R05)', () => {
  it('o limite diário do CRM baixa para 59 enquanto o resgate espera a vaga: nada sai, e a mensagem fica na fila', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(200);

    const n = await resgatarMudandoNaEspera(() =>
      pool.query(`update channel_sessions set daily_message_limit = 59 where id = $1`, [f.numero]),
    );

    expect(n).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('o aquecimento do número baixa para 59 enquanto o resgate espera a vaga: nada sai', async () => {
    const f = await numeroComFila();
    const waha = wahaResponde(200);

    const n = await resgatarMudandoNaEspera(() =>
      pool.query(`update channel_knobs set warmup_daily_caps = $2::jsonb where channel_session_id = $1`, [
        f.numero,
        JSON.stringify([{ minAgeDays: 0, cap: 59 }]),
      ]),
    );

    expect(n).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('o intervalo do número sobe de 5 s para 60 s enquanto o resgate espera a vaga (a última saída foi há 30 s): nada sai', async () => {
    const f = await numeroComFila({ disparos: 58, ultimaHaMs: 30_000 });
    const waha = wahaResponde(200);

    const n = await resgatarMudandoNaEspera(() =>
      pool.query(`update channel_knobs set throttle_ms = 60000 where channel_session_id = $1`, [f.numero]),
    );

    expect(n).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });

  it('o limite do CRM baixa para 59 enquanto o resgate espera a TRAVA do número, presa por outra reserva: nada sai', async () => {
    // A espera de verdade: outra reserva do mesmo número segura a trava. A regra lida antes da
    // trava (mesmo depois de ter a conexão) conferia a vaga com o limite de 60.
    const f = await numeroComFila();
    const waha = wahaResponde(200);
    const outraReserva = await pool.connect();
    let resgate: Promise<number> | undefined;
    try {
      await outraReserva.query('begin');
      await outraReserva.query('select pg_advisory_xact_lock(hashtext($1))', [f.numero]);
      resgate = resgatar();
      await alguemEsperaATravaDo(f.numero);
      await pool.query(`update channel_sessions set daily_message_limit = 59 where id = $1`, [f.numero]);
    } finally {
      await outraReserva.query('commit');
      outraReserva.release();
    }

    expect(await resgate).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect((await estado(f)).sentToday).toBe(59);
  });
});

/**
 * F4r do cxj (12/11/2026), R06: a cadeia não deixa a IA falar com quem passou para a equipe, pediu
 * para ser sempre atendido por gente, ou é contato pessoal (`readStopFlags`, a primeira regra
 * dura); o resgate só olhava o bloqueio, e a resposta da IA presa saía depois da passagem. Agora o
 * resgate confere a mesma régua na mensagem da IA, antes e depois da espera da vaga, e a que não
 * sai vira falha com o motivo da cadeia.
 */
describe('F4r no Postgres real · o resgate para onde a cadeia para (R06)', () => {
  it.each([
    ['force_human', 'atendimento_com_humano'],
    ['ai_opt_out', 'contato_bloqueado'],
    ['is_personal', 'contato_bloqueado'],
  ])(
    'o contato ganhou %s depois que a resposta da IA ficou presa: ela não sai e vira falha (%s), sem vaga',
    async (trava, motivo) => {
      const f = await numeroComFila({ origem: 'inbound_turn' });
      await pool.query(`update contacts set ${trava} = true where id = $1`, [f.contato]);
      const waha = wahaResponde(200);

      expect(await resgatar()).toBe(0);

      expect(waha).not.toHaveBeenCalled();
      expect(await falhaDa(f)).toEqual({ status: 'failed', error_code: motivo });
      expect(await vagasEm(f, AGORA)).toBe(0);
    },
  );

  it('a conversa passa para a equipe enquanto o resgate espera a vaga: nada sai, a vaga volta, e a resposta vira falha', async () => {
    const f = await numeroComFila({ origem: 'inbound_turn' });
    const waha = wahaResponde(200);

    const n = await resgatarMudandoNaEspera(() =>
      pool.query(`update contacts set force_human = true where id = $1`, [f.contato]),
    );

    expect(n).toBe(0);
    expect(waha).not.toHaveBeenCalled();
    expect(await falhaDa(f)).toEqual({ status: 'failed', error_code: 'atendimento_com_humano' });
    expect(await vagasEm(f, AGORA)).toBe(0);
  });

  it.each(['automation', 'system'] as const)(
    'a mensagem presa de %s não sai para o contato que virou pessoal: vira falha (contato_bloqueado), sem vaga',
    async (sentVia) => {
      // O envio pela API recusa tudo ao contato pessoal, manual ou automático (spec 21, etapa 11).
      const f = await numeroComFila({ sentVia });
      await pool.query(`update contacts set is_personal = true where id = $1`, [f.contato]);
      const waha = wahaResponde(200);

      expect(await resgatar()).toBe(0);

      expect(waha).not.toHaveBeenCalled();
      expect(await falhaDa(f)).toEqual({ status: 'failed', error_code: 'contato_bloqueado' });
      expect(await vagasEm(f, AGORA)).toBe(0);
    },
  );

  it('controle: a mensagem presa de automação sai com a conversa passada para a equipe (a passagem cala a IA, não a automação)', async () => {
    const f = await numeroComFila({ sentVia: 'automation' });
    await pool.query(`update contacts set force_human = true where id = $1`, [f.contato]);
    const waha = wahaResponde(200);

    expect(await resgatar()).toBe(1);

    expect(waha).toHaveBeenCalledTimes(1);
    expect(await statusDa(f)).toBe('sent');
  });
});

/**
 * F4r do cxj (12/11/2026), R07: a cadeia não responde fora da janela de resposta do número nem
 * dispara fora da janela de disparo (`decidePacing`); o resgate reenviava a qualquer hora, e a
 * resposta presa saía às 3h. Agora a janela do tipo da mensagem é conferida sob a trava, na
 * reserva; fechada, a mensagem fica na fila, sem vaga, para o tique que a encontrar aberta.
 */
describe('F4r no Postgres real · o resgate respeita a janela do número (R07)', () => {
  const JANELA = { disparo: [9, 18] as [number, number], resposta: [7, 22] as [number, number] };
  const MADRUGADA = new Date('2026-11-19T06:00:00Z'); // 3h em São Paulo
  const OITO_HORAS = new Date('2026-11-18T11:00:00Z'); // 8h em São Paulo

  it('a resposta presa não sai às 3h, fora da janela de resposta (7h às 22h): fica na fila, sem vaga', async () => {
    const f = await numeroComFila({ origem: 'inbound_turn', janela: JANELA });
    const waha = wahaResponde(200);

    expect(await resgatar(MADRUGADA)).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect(await vagasEm(f, MADRUGADA)).toBe(0);
  });

  it('às 8h, o follow-up preso (disparo, janela das 9h às 18h) não sai, e fica na fila', async () => {
    const f = await numeroComFila({ disparos: 0, origem: 'followup_turn', janela: JANELA });
    const waha = wahaResponde(200);

    expect(await resgatar(OITO_HORAS)).toBe(0);

    expect(waha).not.toHaveBeenCalled();
    expect(await statusDa(f)).toBe('queued');
    expect(await vagasEm(f, OITO_HORAS)).toBe(0);
  });

  it('controle: às 8h, a resposta presa (janela das 7h às 22h) sai', async () => {
    const f = await numeroComFila({ disparos: 0, origem: 'inbound_turn', janela: JANELA });
    const waha = wahaResponde(200);

    expect(await resgatar(OITO_HORAS)).toBe(1);

    expect(waha).toHaveBeenCalledTimes(1);
    expect(await statusDa(f)).toBe('sent');
    expect(await respostasEm(f, OITO_HORAS)).toBe(1);
  });

  it('a janela fechada devolve a trava do número: outra sessão do banco a pega na hora', async () => {
    const f = await numeroComFila({ origem: 'inbound_turn', janela: JANELA });
    wahaResponde(200);

    expect(await resgatar(MADRUGADA)).toBe(0);

    const outraSessao = new pg.Client(CONEXAO);
    await outraSessao.connect();
    try {
      const { rows } = await outraSessao.query<{ livre: boolean }>(
        'select pg_try_advisory_xact_lock(hashtext($1)) as livre',
        [f.numero],
      );
      expect(rows[0]!.livre).toBe(true);
    } finally {
      await outraSessao.end();
    }
  });
});
