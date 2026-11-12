/**
 * A HORA DA VAGA NO ENVIO, NO POSTGRES DE VERDADE (F4t do cxj, 12/11/2026: T02 e T03; versão 15).
 *
 * A bancada (`fixture`, `enfileirar`, `ligar`, a fachada que conta as leituras) e o T03 são os do cxj, copiados da
 * cópia da revisão (`tests/invariants/revisao-cxj-f4t-fronteiras.test.ts`) sem mudar a conta.
 *
 * T02: a reserva da campanha com o relógio lê o instante sob a trava, depois da espera, e não antes.
 * T03: no resgate, a última consulta antes do envio é lenta, e a vaga ficava com a hora da reserva: as duas mensagens
 * saíam a 4 s uma da outra, com o intervalo do chip em 5 s. Na versão 15, a vaga mais velha que a folga não sai (volta,
 * e a mensagem espera o tique seguinte), e a reserva do resgate pede o intervalo mais a folga.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS as FOLGA,
  redriveQueued,
} from "@/lib/agent-engine/edge/crm/session-reconciler";
import { recordSend, reservarVaga } from "@/lib/agent-engine/pacing/store";

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 6,
});
afterAll(() => pool.end());
// O resgate é global: o que ficar `queued` de um teste não pode ir para o tique do seguinte.
afterEach(async () => {
  vi.restoreAllMocks();
  await pool.query("update messages set status='failed' where status='queued'");
});
const agora = new Date("2026-11-18T14:00:00Z");
const regra = { limite: 60, desde: new Date("2026-11-18T03:00:00Z"), vagas: 1, intervaloMs: 5000 };
async function fixture() {
  const org = randomUUID(), contact = randomUUID(), session = randomUUID(), job = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,'Teste da vaga','Teste da vaga','America/Sao_Paulo')",
    [org],
  );
  await pool.query("insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Contato fictício',$3)", [
    contact,
    org,
    "+" + "55" + "88" + "9".repeat(5) + "1234",
  ]);
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted,daily_message_limit) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea,60)",
    [session, org],
  );
  await pool.query("insert into job_queue(id,organization_id,contact_id,kind) values($1,$2,$3,'inbound_turn')", [job, org, contact]);
  await pool.query(
    "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,warmup_daily_caps) values($1,$2,5000,0,$3::jsonb)",
    [org, session, JSON.stringify([{ minAgeDays: 0, cap: null }])],
  );
  for (let i = 0; i < 59; i++) await recordSend(pool, org, session, new Date(+agora - 3600000 + i));
  return { org, contact, session, job };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function portao() {
  let abrir!: () => void;
  const espera = new Promise<void>((r) => {
    abrir = r;
  });
  return { abrir, espera };
}
const cfg = { wahaBaseUrl: "http://teste.invalid", wahaApiKey: "ficticio", intervalMs: 1000, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
async function enfileirar(f: Fixture) {
  const conversa = randomUUID(), id = randomUUID();
  await pool.query(
    "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
    [conversa, f.org, f.contact, f.session],
  );
  await pool.query(
    "insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,created_at,metadata) values($1,$2,$3,$4,$5,'outbound','text','Fictício','queued','ai',now()-interval '10 minutes','{}')",
    [id, f.org, conversa, f.contact, f.session],
  );
  return id;
}
async function ligar(f: Fixture, id: string) {
  await pool.query(
    "insert into send_ledger(id,organization_id,contact_id,job_id,seq,body_hash,status,crm_message_id) values($1,$2,$3,$4,0,'ficticio','queued',$1)",
    [id, f.org, f.contact, f.job],
  );
  await pool.query("update job_queue set status='done' where id=$1", [f.job]);
}
async function segunda(id: string) {
  const outra = randomUUID();
  await pool.query("update messages set created_at=now()-interval '20 minutes' where id=$1", [id]);
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,created_at,metadata)
     select $2,organization_id,conversation_id,contact_id,channel_session_id,'outbound','text','Fictício 2','queued','ai',now()-interval '10 minutes','{}' from messages where id=$1`,
    [id, outra],
  );
  return outra;
}
const vagasDoNumero = async (f: Fixture) =>
  Number((await pool.query("select count(*) n from pacing_ledger where channel_session_id=$1", [f.session])).rows[0].n);

describe("versão 15 — a hora da vaga, no Postgres", () => {
  it("T02 ⭐ com o relógio, a reserva da campanha grava o instante lido sob a trava, depois da espera", async () => {
    const f = await fixture(), dono = await pool.connect();
    await dono.query("begin");
    await dono.query("select pg_advisory_xact_lock(hashtext($1))", [f.session]);
    const entrou = portao();
    let horario = new Date("2026-11-18T20:59:59Z");
    const fachada = {
      connect: async () => {
        const db = await pool.connect(), query = db.query.bind(db);
        db.query = (async (...args: unknown[]) => {
          if (String(args[0]).includes("pg_advisory_xact_lock")) entrou.abrir();
          return Reflect.apply(query, db, args);
        }) as typeof db.query;
        return db;
      },
    } as unknown as pg.Pool;
    const reserva = reservarVaga(fachada, f.org, f.session, () => horario, regra);
    try {
      await entrou.espera;
      horario = new Date("2026-11-18T21:00:01Z");
    } finally {
      await dono.query("rollback");
      dono.release();
    }
    expect(await reserva).toBe("reservada");
    const { rows } = await pool.query("select max(sent_at) instante from pacing_ledger where channel_session_id=$1", [f.session]);
    expect(+rows[0].instante).toBe(+new Date("2026-11-18T21:00:01Z"));
  });

  // O T03 do cxj, como ele o escreveu: a 2ª leitura da organização é a última consulta antes do envio da 1ª mensagem.
  it.each([false, true])("T03 ⭐ (cxj) um watchdog, mesmo lote, espaçamento padrão; última consulta lenta=%s", async (lenta) => {
    const f = await fixture(), id = await enfileirar(f);
    await ligar(f, id);
    await segunda(id);
    let relogio = agora, leituras = 0;
    const query = pool.query.bind(pool);
    const fachada = {
      query: async (...args: unknown[]) => {
        if (String(args[0]).includes("fn_org_operante") && ++leituras === 2 && lenta) relogio = new Date(+agora + 30000);
        return Reflect.apply(query, pool, args);
      },
      connect: pool.connect.bind(pool),
    } as unknown as pg.Pool;
    const saidas: number[] = [];
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saidas.push(+relogio);
      relogio = new Date(+relogio + 4000);
      return new Response("{}", { status: 200 });
    });
    await redriveQueued(fachada, { ...cfg, redriveSpacingMs: 4000 }, log, undefined, () => relogio);
    if (saidas.length === 2) expect(saidas[1]! - saidas[0]!).toBe(4000);
    expect(saidas.length, "o segundo envio só pode começar após 5 s do primeiro").toBe(1);
  }, 30_000);

  it("T03 ⭐ a consulta lenta passa da folga: a vaga volta, nada sai, e a mensagem sai no tique seguinte", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await ligar(f, id);
    let relogio = agora, leituras = 0;
    const query = pool.query.bind(pool);
    const fachada = {
      query: async (...args: unknown[]) => {
        if (String(args[0]).includes("fn_org_operante") && ++leituras === 2) relogio = new Date(+relogio + FOLGA + 1);
        return Reflect.apply(query, pool, args);
      },
      connect: pool.connect.bind(pool),
    } as unknown as pg.Pool;
    const transporte = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    expect(await redriveQueued(fachada, cfg, log, undefined, () => relogio)).toBe(0);
    expect(transporte).not.toHaveBeenCalled();
    expect(await vagasDoNumero(f)).toBe(59);
    expect((await pool.query("select status from messages where id=$1", [id])).rows[0].status).toBe("queued");
    relogio = new Date(+relogio + 60_000);
    expect(await redriveQueued(fachada, cfg, log, undefined, () => relogio)).toBe(1);
    expect(await vagasDoNumero(f)).toBe(60);
  });

  it("T03 ⭐ a demora abaixo da folga: o intervalo mais a folga segura a 2ª mensagem, que sairia a 4,5 s da 1ª", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await ligar(f, id);
    await segunda(id);
    let relogio = agora, leituras = 0;
    const query = pool.query.bind(pool);
    const fachada = {
      query: async (...args: unknown[]) => {
        if (String(args[0]).includes("fn_org_operante") && ++leituras === 2) relogio = new Date(+relogio + FOLGA - 100);
        return Reflect.apply(query, pool, args);
      },
      connect: pool.connect.bind(pool),
    } as unknown as pg.Pool;
    const saidas: number[] = [];
    // Espaçamento de 4,5 s (4 s + 0,125 × 4 s): a 2ª reserva cai entre o intervalo (5 s) e o intervalo mais a folga.
    vi.spyOn(Math, "random").mockReturnValue(0.125);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saidas.push(+relogio);
      relogio = new Date(+relogio + 4500);
      return new Response("{}", { status: 200 });
    });
    await redriveQueued(fachada, { ...cfg, redriveSpacingMs: 4000 }, log, undefined, () => relogio);
    if (saidas.length === 2) expect(saidas[1]! - saidas[0]!).toBeGreaterThanOrEqual(5000);
    expect(saidas).toHaveLength(1);
  }, 30_000);

  it("controle: a demora igual à folga ainda sai", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await ligar(f, id);
    let relogio = agora, leituras = 0;
    const query = pool.query.bind(pool);
    const fachada = {
      query: async (...args: unknown[]) => {
        if (String(args[0]).includes("fn_org_operante") && ++leituras === 2) relogio = new Date(+relogio + FOLGA);
        return Reflect.apply(query, pool, args);
      },
      connect: pool.connect.bind(pool),
    } as unknown as pg.Pool;
    const transporte = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    expect(await redriveQueued(fachada, cfg, log, undefined, () => relogio)).toBe(1);
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it("controle: com o intervalo padrão do número (1,2 s) e o espaçamento padrão (4 s), o lote sai inteiro no mesmo tique", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await ligar(f, id);
    await segunda(id);
    await pool.query("update channel_knobs set throttle_ms=1200 where channel_session_id=$1", [f.session]);
    let relogio = agora;
    const saidas: number[] = [];
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saidas.push(+relogio);
      relogio = new Date(+relogio + 4000);
      return new Response("{}", { status: 200 });
    });
    await redriveQueued(pool, { ...cfg, redriveSpacingMs: 4000 }, log, undefined, () => relogio);
    expect(saidas).toEqual([+agora, +agora + 4000]);
  }, 30_000);

  it("controle: sem intervalo no número, a reserva do resgate não ganha folga, e o lote sai inteiro no mesmo tique", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await ligar(f, id);
    await segunda(id);
    await pool.query("update channel_knobs set throttle_ms=0 where channel_session_id=$1", [f.session]);
    let relogio = agora;
    const saidas: number[] = [];
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saidas.push(+relogio);
      relogio = new Date(+relogio + 100);
      return new Response("{}", { status: 200 });
    });
    await redriveQueued(pool, cfg, log, undefined, () => relogio);
    expect(saidas).toEqual([+agora, +agora + 100]);
  });
});
