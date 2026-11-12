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
 *
 * Versão 16 (F4u do cxj, 12/11/2026: U02 e U01). U02: a garantia da 15 valia entre duas saídas do mesmo emissor; a
 * resposta da IA media o intervalo a partir da hora da vaga do resgate, e saía a 3,1 s da mensagem dele, com o intervalo
 * em 5 s. Agora a vaga guarda a hora mais tardia da saída (o instante mais a folga), e todo emissor mede o intervalo a
 * partir dela; e a IA grava o registro na hora em que sai da espera, e não na de antes da pausa humana. U01: o resgate
 * da campanha de consentimento respeita a janela da própria campanha. O U01 e o U02 são os do cxj, copiados da cópia da
 * revisão (`tests/invariants/revisao-cxj-f4u-fronteiras.test.ts`); no U02, o `sleep` registra a espera em vez de lançar.
 * Um controle da 15 mudou de premissa (o lote do resgate no mesmo tique): ver o comentário dele.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS as FOLGA,
  redriveQueued,
} from "@/lib/agent-engine/edge/crm/session-reconciler";
import { pacingGate, runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import { recordSend, reservarVaga, undoSend } from "@/lib/agent-engine/pacing/store";

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

  // Na versão 16 a premissa deste controle mudou: a linha da vaga leva a folga, e a reserva segue pedindo o intervalo mais
  // a folga (a margem para o tempo entre o registro da IA e a saída dela). Entre duas mensagens do resgate, o intervalo
  // efetivo é o do número mais duas folgas: 5,2 s no padrão. Com o espaçamento de 4 s a 8 s, o lote sai no mesmo tique
  // quando o espaçamento passa disso, e a mensagem que cair antes espera o tique seguinte.
  it("controle: com o intervalo padrão do número (1,2 s) e o espaçamento de 5,2 s, o lote sai inteiro no mesmo tique", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await ligar(f, id);
    await segunda(id);
    await pool.query("update channel_knobs set throttle_ms=1200 where channel_session_id=$1", [f.session]);
    let relogio = agora;
    const saidas: number[] = [];
    // 4 s + 0,3 × 4 s = 5,2 s: o intervalo padrão mais as duas folgas.
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saidas.push(+relogio);
      relogio = new Date(+relogio + 1200 + 2 * FOLGA);
      return new Response("{}", { status: 200 });
    });
    await redriveQueued(pool, { ...cfg, redriveSpacingMs: 4000 }, log, undefined, () => relogio);
    expect(saidas).toEqual([+agora, +agora + 1200 + 2 * FOLGA]);
  }, 30_000);

  it("controle: com o espaçamento mínimo (4 s), a 2ª mensagem do lote espera o tique seguinte, e sai nele", async () => {
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
    expect(await redriveQueued(pool, { ...cfg, redriveSpacingMs: 4000 }, log, undefined, () => relogio)).toBe(1);
    relogio = new Date(+agora + 60_000);
    expect(await redriveQueued(pool, { ...cfg, redriveSpacingMs: 4000 }, log, undefined, () => relogio)).toBe(1);
    expect(saidas).toEqual([+agora, +agora + 60_000]);
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

/** A resposta da IA pela cadeia de verdade (`runBeforeSend` com o `pacingGate`), como o cxj a chama no U02. */
async function responder(f: Fixture, now: Date, opts: { relogio?: () => Date } = {}) {
  const esperas: number[] = [];
  let saiuEm: number | null = null;
  const resultado = await runBeforeSend({
    pool,
    log,
    tenantId: f.org,
    leadId: f.contact,
    jobId: f.job,
    channelSessionId: f.session,
    body: "Resposta fictícia.",
    optedOutThisTurn: false,
    crmDailyLimit: 60,
    now,
    ...(opts.relogio ? { relogio: opts.relogio } : {}),
    rng: () => 0,
    // A espera do intervalo fica registrada, e a saída acontece depois dela.
    sleep: async (ms: number) => {
      esperas.push(ms);
    },
    gates: [pacingGate],
    enforceSpinning: false,
    resposta: true,
    send: async () => {
      saiuEm = +now + esperas.reduce((a, b) => a + b, 0);
      return { kind: "sent" as const, idempotencyKey: "ficticio", messageId: "ficticio" };
    },
  });
  return { resultado, esperas, saiuEm: saiuEm as number | null };
}
const ultimaVaga = async (f: Fixture) =>
  +(await pool.query("select max(sent_at) instante from pacing_ledger where channel_session_id=$1", [f.session])).rows[0]
    .instante;
/** A mensagem presa vira a de uma campanha, com a janela 9h–18h, e o número abre das 7h às 22h (o U01 do cxj). */
async function daCampanha(f: Fixture, id: string, base: string) {
  const camp = randomUUID();
  await pool.query(
    "insert into campaigns(id,organization_id,name,channel_session_id,base_legal,lia_ref,status,janela_inicio_hora,janela_fim_hora) values($1,$2,'Fictícia',$3,$4,'fictícia','running',9,18)",
    [camp, f.org, f.session, base],
  );
  await pool.query("update messages set sent_via='automation', metadata=$2::jsonb where id=$1", [
    id,
    JSON.stringify({ source: "campaign", campaign_id: camp }),
  ]);
  await pool.query("update channel_knobs set window_start_hour=7,window_end_hour=22 where channel_session_id=$1", [f.session]);
}

describe("versão 16 — a vaga guarda a hora mais tardia da saída, e todo emissor mede o intervalo dela (F4u do cxj)", () => {
  // O U02 do cxj, como ele o escreveu; só o `sleep`, que lançava, passa a registrar a espera.
  it("U02 ⭐ (cxj) a resposta da IA depois do resgate espera o intervalo a partir da saída mais tardia dele", async () => {
    const f = await fixture();
    await enfileirar(f);
    let relogio = agora, leituras = 0;
    const query = pool.query.bind(pool);
    const fachada = {
      query: async (...args: unknown[]) => {
        if (String(args[0]).includes("fn_org_operante") && ++leituras === 2) relogio = new Date(+agora + 1900);
        return Reflect.apply(query, pool, args);
      },
      connect: pool.connect.bind(pool),
    } as unknown as pg.Pool;
    const saidas: number[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saidas.push(+relogio);
      return new Response("{}", { status: 200 });
    });
    expect(await redriveQueued(fachada, cfg, log, undefined, () => relogio)).toBe(1);
    const ia = await responder(f, new Date(+agora + 5000));
    expect(ia.resultado.status).toBe("sent");
    // A vaga do resgate ficou no instante mais a folga (2 s): a IA, a 5 s, espera 2 s e sai a 7 s, 5,1 s depois dele.
    expect(ia.esperas).toEqual([FOLGA]);
    expect(ia.saiuEm! - saidas[0]!).toBeGreaterThanOrEqual(5000);
  });

  it("o resgate grava a vaga na hora mais tardia da saída: o instante lido sob a trava mais a folga", async () => {
    const f = await fixture();
    await enfileirar(f);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    expect(await redriveQueued(pool, cfg, log, undefined, () => agora)).toBe(1);
    expect(await ultimaVaga(f)).toBe(+agora + FOLGA);
  });

  it("controle: sem intervalo no número, a vaga do resgate fica no instante", async () => {
    const f = await fixture();
    await enfileirar(f);
    await pool.query("update channel_knobs set throttle_ms=0 where channel_session_id=$1", [f.session]);
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    expect(await redriveQueued(pool, cfg, log, undefined, () => agora)).toBe(1);
    expect(await ultimaVaga(f)).toBe(+agora);
  });

  it("a vaga com folga fica no instante mais a folga, o intervalo seguinte conta dela, e a devolução com a folga a acha", async () => {
    const f = await fixture();
    const semTeto = { ...regra, limite: null };
    expect(await reservarVaga(pool, f.org, f.session, agora, { ...semTeto, folgaMs: 10_000 })).toBe("reservada");
    expect(await ultimaVaga(f)).toBe(+agora + 10_000);
    expect(await reservarVaga(pool, f.org, f.session, new Date(+agora + 14_999), semTeto)).toBe("intervalo");
    expect(await reservarVaga(pool, f.org, f.session, new Date(+agora + 15_000), semTeto)).toBe("reservada");
    await undoSend(pool, f.org, f.session, agora, { folgaMs: 10_000 });
    expect(await vagasDoNumero(f)).toBe(60);
    expect(await ultimaVaga(f)).toBe(+agora + 15_000);
  });

  it("U02 na campanha: a resposta da IA depois da vaga da campanha espera o intervalo a partir da saída mais tardia dela", async () => {
    const f = await fixture();
    expect(await reservarVaga(pool, f.org, f.session, agora, { ...regra, folgaMs: 10_000 })).toBe("reservada");
    const ia = await responder(f, new Date(+agora + 5000));
    expect(ia.esperas).toEqual([10_000]);
    expect(ia.saiuEm! - (+agora + 10_000)).toBeGreaterThanOrEqual(5000);
  });

  it("a IA grava o registro na hora do relógio que recebe, depois da pausa humana e da espera, e não na de antes", async () => {
    const f = await fixture();
    const depoisDaPausa = new Date(+agora + 3000);
    const ia = await responder(f, agora, { relogio: () => depoisDaPausa });
    expect(ia.resultado.status).toBe("sent");
    expect(ia.esperas).toEqual([]);
    expect(await ultimaVaga(f)).toBe(+depoisDaPausa);
  });

  it("sem o relógio, a IA grava o registro na hora de `now` mais a espera do intervalo", async () => {
    const f = await fixture();
    await recordSend(pool, f.org, f.session, new Date(+agora - 1000));
    const ia = await responder(f, agora);
    expect(ia.esperas).toEqual([4000]);
    expect(await ultimaVaga(f)).toBe(+agora + 4000);
  });

  it("a IA lê o relógio depois da espera do intervalo: a espera conta na hora do registro", async () => {
    const f = await fixture();
    await recordSend(pool, f.org, f.session, new Date(+agora - 1000));
    // O relógio começa depois da pausa humana (3 s) e anda com a espera; o `now` é o de antes da pausa.
    let relogio = +agora + 3000;
    const resultado = await runBeforeSend({
      pool,
      log,
      tenantId: f.org,
      leadId: f.contact,
      jobId: f.job,
      channelSessionId: f.session,
      body: "Resposta fictícia.",
      optedOutThisTurn: false,
      crmDailyLimit: 60,
      now: agora,
      relogio: () => new Date(relogio),
      rng: () => 0,
      sleep: async (ms: number) => {
        relogio += ms;
      },
      gates: [pacingGate],
      enforceSpinning: false,
      resposta: true,
      send: async () => ({ kind: "sent" as const, idempotencyKey: "ficticio", messageId: "ficticio" }),
    });
    expect(resultado.status).toBe("sent");
    expect(await ultimaVaga(f)).toBe(+agora + 3000 + 4000);
  });

  it("IA → resgate: o resgate seguinte mede o intervalo (mais a folga) da hora em que a IA saiu da espera", async () => {
    const f = await fixture();
    await enfileirar(f);
    await responder(f, agora, { relogio: () => new Date(+agora + 3000) });
    const transporte = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    // A reserva do resgate segue pedindo o intervalo (5 s) mais a folga (2 s), agora a partir da hora da IA (3 s).
    expect(await redriveQueued(pool, cfg, log, undefined, () => new Date(+agora + 9_999))).toBe(0);
    expect(transporte).not.toHaveBeenCalled();
    // Controle: aos 10 s, sai.
    expect(await redriveQueued(pool, cfg, log, undefined, () => new Date(+agora + 10_000))).toBe(1);
  });

  // O U01 do cxj, como ele o escreveu.
  it.each(["legitimate_interest", "consent"])("U01 ⭐ (cxj) resgate de campanha fora da janela própria: %s", async (base) => {
    const f = await fixture(), id = await enfileirar(f);
    await daCampanha(f, id, base);
    const transporte = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    await redriveQueued(pool, cfg, log, undefined, () => new Date("2026-11-18T22:00:00Z"));
    expect(transporte, "19h local: a campanha encerrou às 18h").not.toHaveBeenCalled();
  });

  it("controle do U01: dentro da janela da campanha, o resgate do consentimento sai", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await daCampanha(f, id, "consent");
    const transporte = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    expect(await redriveQueued(pool, cfg, log, undefined, () => agora)).toBe(1);
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it("U01: fora da janela da campanha, a vaga nem é reservada (o motivo vai ao log)", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await daCampanha(f, id, "consent");
    log.info.mockClear();
    const transporte = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    expect(await redriveQueued(pool, cfg, log, undefined, () => new Date("2026-11-18T22:00:00Z"))).toBe(0);
    expect(transporte).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith(
      expect.stringContaining("reenvio adiado"),
      expect.objectContaining({ message_id: id, motivo: "fora_da_janela_da_campanha" }),
    );
  });

  it("U01: o fuso da janela da campanha é o do número principal dela, como na rodada", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await daCampanha(f, id, "consent");
    // O principal fica em Manaus (UTC−4); o número da mensagem, no fuso da organização (São Paulo, UTC−3).
    const principal = randomUUID();
    await pool.query(
      "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted,daily_message_limit) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea,60)",
      [principal, f.org],
    );
    await pool.query("insert into channel_knobs(organization_id,channel_session_id,timezone) values($1,$2,'America/Manaus')", [
      f.org,
      principal,
    ]);
    await pool.query("update campaigns set channel_session_id=$2 where organization_id=$1", [f.org, principal]);
    const transporte = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    // 21h30 UTC: 18h30 em São Paulo (a campanha já fechou lá), 17h30 em Manaus (aberta no principal).
    expect(await redriveQueued(pool, cfg, log, undefined, () => new Date("2026-11-18T21:30:00Z"))).toBe(1);
    expect(transporte).toHaveBeenCalledTimes(1);
  });

  it("U01: a janela da campanha que fecha durante a última consulta também barra o consentimento, e a vaga volta", async () => {
    const f = await fixture(), id = await enfileirar(f);
    await daCampanha(f, id, "consent");
    // 17h59min59s local na reserva; a última consulta leva o relógio às 18h00min01s.
    let relogio = new Date("2026-11-18T20:59:59Z"), leituras = 0;
    const query = pool.query.bind(pool);
    const fachada = {
      query: async (...args: unknown[]) => {
        if (String(args[0]).includes("fn_org_operante") && ++leituras === 2) relogio = new Date("2026-11-18T21:00:01Z");
        return Reflect.apply(query, pool, args);
      },
      connect: pool.connect.bind(pool),
    } as unknown as pg.Pool;
    const transporte = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("{}", { status: 200 }));
    expect(await redriveQueued(fachada, cfg, log, undefined, () => relogio)).toBe(0);
    expect(transporte).not.toHaveBeenCalled();
    expect(await vagasDoNumero(f)).toBe(59);
    expect((await pool.query("select status from messages where id=$1", [id])).rows[0].status).toBe("queued");
  });
});
