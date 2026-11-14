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
 *
 * Versão 17 (F4v do cxj, 12/11/2026: V01 e V02). V02: a espera do intervalo era calculada com o `now` de antes da fila
 * da trava, e a hora gravada era a de depois: cada resposta na fila pagava de novo a espera que já tinha passado (cinco
 * respostas, 197,2 s, contra 16 s). Agora a espera conta do relógio lido sob a trava. V01: a hora do registro da IA era
 * lida antes do INSERT e do commit, e o resgate media dela: uma consulta de 3,1 s deixava IA → resgate a 3,9 s, com o
 * intervalo em 5 s. Agora o registro da IA guarda a hora mais tardia da saída (o instante mais a folga de 10 s)
 * enquanto o transporte está em curso; a saída mais velha do que a folga não acontece (o registro volta, e o job tenta
 * de novo); e, confirmado o transporte, a linha recua para a hora em que ele voltou. O V02 é o do cxj, copiado da cópia da
 * revisão (`tests/invariants/revisao-cxj-f4v-fronteiras.test.ts`); o V01 dele é impossível como escrito (a IA sai a
 * 3,1 s e o resgate a 7 s, com 5 s de intervalo), e entra adaptado: o resgate espera, e sai no tique que cabe.
 *
 * Versão 18 (F4w do cxj, 12/11/2026: W12). A espera que acompanha a linha contava só a soma das fatias, e o tempo de
 * cada releitura ficava de fora: com leituras de 1 s, a resposta que devia esperar 11,2 s esperava 34,2 s. Agora o
 * tempo que passou é o maior entre a soma das fatias e o relógio: a espera termina quando o intervalo passou. O W12 é
 * o do cxj, copiado da cópia da revisão (`tests/invariants/revisao-cxj-f4w-fronteiras.test.ts`), com a conta nova.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import {
  ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS as FOLGA,
  redriveQueued,
} from "@/lib/agent-engine/edge/crm/session-reconciler";
import { pacingGate, runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import { ATRASO_MAXIMO_DA_SAIDA_DO_AGENTE_MS as FOLGA_DA_IA, tomarSaidaDoAgente } from "@/lib/agent-engine/pacing/saida-do-agente";
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
    // Versão 17 (F4v do cxj, V02): a espera conta do relógio sob a trava. A última saída foi 1 s antes do `now`, e o
    // relógio já marca 3 s: falta 1 s do intervalo de 5 s, e não os 4 s contados do `now` (que cobravam de novo a pausa).
    let relogio = +agora + 3000;
    const esperas: number[] = [];
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
        esperas.push(ms);
        relogio += ms;
      },
      gates: [pacingGate],
      enforceSpinning: false,
      resposta: true,
      send: async () => ({ kind: "sent" as const, idempotencyKey: "ficticio", messageId: "ficticio" }),
    });
    expect(resultado.status).toBe("sent");
    expect(esperas).toEqual([1000]);
    expect(await ultimaVaga(f)).toBe(+agora + 3000 + 1000);
  });

  // Linha A, v20 — os dois sobreviventes do arnês de 212 da v19 ("U02 · o registro da IA sem o relógio" e "U02 · o
  // relógio da IA como se lido antes da espera"). Eles sobreviviam porque, confirmado o transporte, a linha vai para a
  // hora em que ele voltou, e o teste de cima só lia a linha DEPOIS. Aqui a espera demora mais do que o pedido (o
  // `sleep` acorda 2,5 s tarde, como num event loop ocupado), e a linha é lida DURANTE o transporte: ela tem de estar
  // na hora lida depois da espera, mais a folga — e não na hora sob a trava mais a espera pedida (sem o relógio), nem
  // no relógio menos a espera (como se lido antes dela).
  it("⭐ v20 · a espera que acorda tarde: durante o transporte, a linha está no relógio de depois da espera, mais a folga", async () => {
    const f = await fixture();
    await recordSend(pool, f.org, f.session, new Date(+agora - 1000));
    let relogio = +agora + 3000;
    let linhaNoTransporte: number | null = null;
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
        relogio += ms + 2500;
      },
      gates: [pacingGate],
      enforceSpinning: false,
      resposta: true,
      send: async () => {
        linhaNoTransporte = await ultimaVaga(f);
        return { kind: "sent" as const, idempotencyKey: "ficticio", messageId: "ficticio" };
      },
    });
    expect(resultado.status).toBe("sent");
    // Pediu 1 s (o intervalo de 5 s conta da última saída, 1 s antes do `now`, e o relógio já marca 3 s), e acordou
    // em 3,5 s: o relógio de depois da espera é `agora + 6,5 s`.
    expect(linhaNoTransporte).toBe(+agora + 6500 + FOLGA_DA_IA);
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

const saiu = () => ({ kind: "sent" as const, idempotencyKey: "ficticio", messageId: "ficticio" });
const soma = (ms: number[]) => ms.reduce((a, b) => a + b, 0);
/** A resposta da IA pela cadeia de verdade, com tudo injetável (o `responder` do cxj na F4v). */
function responderCom(f: Fixture, extras: Partial<Parameters<typeof runBeforeSend>[0]> = {}) {
  return runBeforeSend({
    pool,
    log,
    tenantId: f.org,
    leadId: f.contact,
    jobId: f.job,
    channelSessionId: f.session,
    body: "Uma resposta de texto.",
    optedOutThisTurn: false,
    crmDailyLimit: 60,
    now: agora,
    relogio: () => agora,
    rng: () => 0,
    sleep: async () => {},
    gates: [pacingGate],
    enforceSpinning: false,
    resposta: true,
    send: async () => saiu(),
    ...extras,
  });
}
/** A fachada do cxj (F4v, V01): o banco é o de verdade; `depois` roda logo depois do INSERT do registro da saída. */
function comInsertDoRegistro(depois: () => void) {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const db = await pool.connect();
      const query = db.query.bind(db);
      return {
        query: async (...args: unknown[]) => {
          const r = await Reflect.apply(query, db, args);
          if (String(args[0]).includes("insert into pacing_ledger")) depois();
          return r;
        },
        release: db.release.bind(db),
      };
    },
  } as unknown as pg.Pool;
}

describe("versão 17 — a espera conta do relógio sob a trava, e a saída da IA tem hora mais tardia (F4v do cxj)", () => {
  // O V02 do cxj, como ele o escreveu.
  it("V02 ⭐ (cxj) cinco respostas concorrentes gastam só uma folga e cinco intervalos", async () => {
    const f = await fixture();
    await pool.query("update channel_knobs set throttle_ms=1200 where channel_session_id=$1", [f.session]);
    await reservarVaga(pool, f.org, f.session, agora, { limite: null, desde: agora, vagas: 1, intervaloMs: 0, folgaMs: 10000 });
    let relogio = +agora;
    const esperas: number[] = [], saidas: number[] = [];
    const entradas: Fixture[] = [];
    for (let i = 0; i < 5; i++) {
      const contact = randomUUID(), job = randomUUID();
      await pool.query("insert into contacts(id,organization_id,name) values($1,$2,'Fictício')", [contact, f.org]);
      await pool.query("insert into job_queue(id,organization_id,contact_id,kind) values($1,$2,$3,'inbound_turn')", [job, f.org, contact]);
      entradas.push({ ...f, contact, job });
    }
    const resultados = await Promise.all(
      entradas.map((entrada) =>
        responderCom(entrada, {
          relogio: () => new Date(relogio),
          sleep: async (ms) => {
            esperas.push(ms);
            relogio += ms;
          },
          send: async () => {
            saidas.push(relogio);
            return saiu();
          },
        }),
      ),
    );
    expect(resultados.every((r) => r.status === "sent")).toBe(true);
    expect(saidas).toHaveLength(5);
    expect(relogio - +agora, `esperas: ${esperas.join(", ")} ms`).toBeLessThanOrEqual(16000);
    // E nenhuma saída a menos do intervalo da anterior.
    for (let i = 1; i < saidas.length; i++) expect(saidas[i]! - saidas[i - 1]!).toBeGreaterThanOrEqual(1200);
  });

  it("V02: a espera do intervalo conta do relógio lido sob a trava, e não do `now` de antes da fila", async () => {
    const f = await fixture();
    await recordSend(pool, f.org, f.session, new Date(+agora + 1000), { resposta: true });
    // O job leu o `now` às 14h e passou 3 s na fila da trava: sob a trava, o relógio marca 3 s.
    let relogio = +agora + 3000;
    const esperas: number[] = [];
    const r = await responderCom(f, {
      relogio: () => new Date(relogio),
      sleep: async (ms) => {
        esperas.push(ms);
        relogio += ms;
      },
    });
    expect(r.status).toBe("sent");
    // A última saída foi a 1 s, e o intervalo é de 5 s: faltam 3 s, e não os 6 s contados do `now`.
    expect(esperas).toEqual([3000]);
    expect(await ultimaVaga(f)).toBe(+agora + 6000);
  });

  it("V01: com o transporte da IA em curso, a linha guarda a hora mais tardia da saída; confirmado, a hora em que ele voltou", async () => {
    const f = await fixture();
    let durante: number | null = null;
    const r = await responderCom(f, {
      send: async () => {
        durante = await ultimaVaga(f);
        return saiu();
      },
    });
    expect(r.status).toBe("sent");
    expect(durante).toBe(+agora + FOLGA_DA_IA);
    expect(await ultimaVaga(f)).toBe(+agora);
    expect(await vagasDoNumero(f)).toBe(60);
    // Só a linha desta saída muda de hora: as outras do número ficam onde estavam.
    const maisAntiga = await pool.query("select min(sent_at) instante from pacing_ledger where channel_session_id=$1", [f.session]);
    expect(+maisAntiga.rows[0].instante).toBe(+agora - 3600000);
  });

  it("V01 ⭐ a saída da IA mais velha do que a folga não acontece: o transporte não é chamado, e o registro volta", async () => {
    const f = await fixture();
    let relogio = +agora;
    const send = vi.fn(async () => saiu());
    const r = await responderCom(f, {
      pool: comInsertDoRegistro(() => {
        relogio += FOLGA_DA_IA + 1;
      }),
      relogio: () => new Date(relogio),
      send,
    });
    // O desfecho é o do transporte indisponível: o job tenta de novo pela fila, com a mesma chave.
    expect(r).toMatchObject({ status: "sent", outcome: { kind: "unavailable", reason: "saida_do_agente_vencida" } });
    expect(send).not.toHaveBeenCalled();
    expect(await vagasDoNumero(f)).toBe(59);
    // A tentativa que não saiu fica na auditoria da cadeia, sem veto.
    const auditoria = await pool.query("select vetoed_code from before_send_traces where job_id=$1", [f.job]);
    expect(auditoria.rows).toEqual([{ vetoed_code: null }]);
  });

  it("controle do V01: no limite da folga, a resposta sai, e a linha fica na hora em que saiu", async () => {
    const f = await fixture();
    let relogio = +agora;
    const r = await responderCom(f, {
      pool: comInsertDoRegistro(() => {
        relogio += FOLGA_DA_IA;
      }),
      relogio: () => new Date(relogio),
    });
    expect(r.status).toBe("sent");
    expect(await ultimaVaga(f)).toBe(+agora + FOLGA_DA_IA);
    expect(await vagasDoNumero(f)).toBe(60);
  });

  // O V01 do cxj, adaptado: como escrito, é impossível (a IA sai `atraso` depois do registro, e o tique dele cai a menos
  // do intervalo dessa saída). O que se cobra é o que ele mede: a distância entre as duas saídas.
  it.each([
    [5000, 3100],
    [1200, 2500],
  ])("V01 ⭐ (cxj, adaptado) intervalo %i ms e demora %i ms no INSERT: IA → resgate não fica a menos do intervalo", async (intervalo, atraso) => {
    const f = await fixture();
    await enfileirar(f);
    await pool.query("update channel_knobs set throttle_ms=$2 where channel_session_id=$1", [f.session, intervalo]);
    let relogio = +agora;
    const saidas: number[] = [];
    await responderCom(f, {
      pool: comInsertDoRegistro(() => {
        relogio += atraso;
      }),
      relogio: () => new Date(relogio),
      send: async () => {
        saidas.push(relogio);
        return saiu();
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      saidas.push(relogio);
      return new Response("{}", { status: 200 });
    });
    // O tique do cxj: o intervalo mais a folga do resgate depois do REGISTRO. A IA saiu `atraso` depois, e o resgate espera.
    relogio = +agora + intervalo + FOLGA;
    expect(await redriveQueued(pool, cfg, log, undefined, () => new Date(relogio))).toBe(0);
    // O intervalo mais a folga do resgate, contados da saída de verdade: sai.
    relogio = +agora + atraso + intervalo + FOLGA;
    expect(await redriveQueued(pool, cfg, log, undefined, () => new Date(relogio))).toBe(1);
    expect(saidas).toHaveLength(2);
    expect(saidas[1]! - saidas[0]!, `distância medida: ${saidas[1]! - saidas[0]!} ms`).toBeGreaterThanOrEqual(intervalo);
  });

  it("V01: IA → IA em sequência, com a 1ª lenta: a 2ª mede o intervalo da hora em que a 1ª saiu", async () => {
    const f = await fixture();
    let relogio = +agora, lento = true;
    const saidas: number[] = [];
    const opts = {
      pool: comInsertDoRegistro(() => {
        if (lento) relogio += 3100;
      }),
      relogio: () => new Date(relogio),
      sleep: async (ms: number) => {
        relogio += ms;
      },
      send: async () => {
        saidas.push(relogio);
        return saiu();
      },
    };
    await responderCom(f, opts);
    lento = false;
    await responderCom(f, { ...opts, now: new Date(relogio) });
    expect(saidas).toHaveLength(2);
    expect(saidas[1]! - saidas[0]!, `distância medida: ${saidas[1]! - saidas[0]!} ms`).toBeGreaterThanOrEqual(5000);
  });

  it("V01: IA → IA em paralelo: com a 1ª ainda no transporte, a 2ª espera o intervalo a partir da hora mais tardia dela", async () => {
    const f = await fixture();
    const entrou = portao(), soltar = portao();
    const esperas: number[] = [];
    const primeira = responderCom(f, {
      send: async () => {
        entrou.abrir();
        await soltar.espera;
        return saiu();
      },
    });
    try {
      await entrou.espera;
      const segunda = await responderCom(f, {
        sleep: async (ms) => {
          esperas.push(ms);
        },
      });
      expect(segunda.status).toBe("sent");
    } finally {
      soltar.abrir();
      await primeira;
    }
    // A 1ª não voltou durante a espera: a 2ª espera a hora mais tardia dela mais o intervalo, em fatias.
    expect(soma(esperas)).toBe(FOLGA_DA_IA + 5000);
    // Em fatias de 500 ms, com a linha relida depois de cada uma: 30 fatias, mesmo com o relógio parado.
    expect(esperas).toEqual(Array.from({ length: 30 }, () => 500));
    // A 2ª saiu na hora da espera dela, e a linha não recua para antes do registro.
    expect(await ultimaVaga(f)).toBe(+agora + FOLGA_DA_IA + 5000);
  });

  it("o transporte que lança deixa a linha na hora mais tardia: a saída é incerta, e conta a mais, nunca a menos", async () => {
    const f = await fixture();
    const erro = await responderCom(f, {
      send: async () => {
        throw new Error("transporte fora");
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect((erro as Error).message).toBe("transporte fora");
    expect(await vagasDoNumero(f)).toBe(60);
    expect(await ultimaVaga(f)).toBe(+agora + FOLGA_DA_IA);
  });

  it("se o ajuste da linha falhar, a resposta já saiu: a linha fica na hora mais tardia, e o log avisa", async () => {
    const f = await fixture();
    const erros = vi.fn();
    const query = pool.query.bind(pool);
    const fachada = {
      query: async (...args: unknown[]) => {
        if (String(args[0]).includes("update pacing_ledger")) throw new Error("banco indisponível");
        return Reflect.apply(query, pool, args);
      },
      connect: pool.connect.bind(pool),
    } as unknown as pg.Pool;
    const r = await responderCom(f, { pool: fachada, log: { ...log, error: erros } });
    expect(r.status).toBe("sent");
    expect(await ultimaVaga(f)).toBe(+agora + FOLGA_DA_IA);
    expect(erros).toHaveBeenCalledWith(
      expect.stringContaining("hora mais tardia"),
      expect.objectContaining({ channel_session_id: f.session }),
    );
  });

  it("o transporte roda com a saída no escopo: a 1ª mensagem física a toma, a 2ª não, e fora dele não há saída", async () => {
    const f = await fixture();
    let primeira: ReturnType<typeof tomarSaidaDoAgente> | undefined, segunda: ReturnType<typeof tomarSaidaDoAgente> | undefined;
    await responderCom(f, {
      send: async () => {
        primeira = tomarSaidaDoAgente();
        segunda = tomarSaidaDoAgente();
        return saiu();
      },
    });
    expect(primeira?.instante).toEqual(agora);
    expect(primeira?.folgaMs).toBe(FOLGA_DA_IA);
    expect(segunda).toBeNull();
    expect(tomarSaidaDoAgente()).toBeNull();
  });

  it("controle: sem intervalo no número, o registro da IA fica no instante, e a demora não barra a resposta", async () => {
    const f = await fixture();
    await pool.query("update channel_knobs set throttle_ms=0 where channel_session_id=$1", [f.session]);
    let relogio = +agora, durante: number | null = null, noEscopo: unknown = "não lido";
    const r = await responderCom(f, {
      pool: comInsertDoRegistro(() => {
        relogio += 60_000;
      }),
      relogio: () => new Date(relogio),
      send: async () => {
        durante = await ultimaVaga(f);
        noEscopo = tomarSaidaDoAgente();
        return saiu();
      },
    });
    expect(r.status).toBe("sent");
    expect(durante).toBe(+agora);
    expect(noEscopo).toBeNull();
    expect(await ultimaVaga(f)).toBe(+agora);
  });

  it("controle: sem o relógio não há como medir a idade: o registro fica em `now` mais a espera, sem folga", async () => {
    const f = await fixture();
    let durante: number | null = null, noEscopo: unknown = "não lido";
    const r = await responderCom(f, {
      relogio: undefined,
      send: async () => {
        durante = await ultimaVaga(f);
        noEscopo = tomarSaidaDoAgente();
        return saiu();
      },
    });
    expect(r.status).toBe("sent");
    expect(durante).toBe(+agora);
    expect(noEscopo).toBeNull();
  });

  it("a resposta que não saiu (`queued`) devolve o registro inteiro, mesmo gravado na hora mais tardia", async () => {
    const f = await fixture();
    const r = await responderCom(f, {
      send: async () => ({ kind: "queued" as const, idempotencyKey: "ficticio", messageId: null }),
    });
    expect(r.status).toBe("sent");
    expect(await vagasDoNumero(f)).toBe(59);
  });

  it("V01: o transporte que volta depois da hora mais tardia leva a linha para a hora em que voltou, e a resposta seguinte mede dela", async () => {
    const f = await fixture();
    let relogio = +agora;
    const esperas: number[] = [];
    const opts = {
      relogio: () => new Date(relogio),
      sleep: async (ms: number) => {
        esperas.push(ms);
        relogio += ms;
      },
    };
    const r = await responderCom(f, {
      ...opts,
      send: async () => {
        // A chamada ao provedor levou 30 s, e a mensagem pode ter saído no fim dela.
        relogio += 30_000;
        return saiu();
      },
    });
    expect(r.status).toBe("sent");
    // A linha não fica antes da saída de verdade: vai para a hora em que o transporte voltou, depois da hora mais tardia.
    expect(await ultimaVaga(f)).toBe(+agora + 30_000);
    expect(await vagasDoNumero(f)).toBe(60);
    // A resposta seguinte chega 1 s depois e espera o resto do intervalo, contado dessa hora.
    relogio += 1000;
    await responderCom(f, { ...opts, now: new Date(relogio) });
    expect(esperas).toEqual([4000]);
  });

  it("o relógio que recua durante o transporte não leva a linha para antes do instante do registro", async () => {
    const f = await fixture();
    let relogio = +agora;
    const r = await responderCom(f, {
      relogio: () => new Date(relogio),
      send: async () => {
        relogio -= 5000;
        return saiu();
      },
    });
    expect(r.status).toBe("sent");
    expect(await ultimaVaga(f)).toBe(+agora);
  });

  it("V02: a hora do registro é a do relógio sob a trava mais a espera, mesmo que o relógio não ande durante a espera", async () => {
    const f = await fixture();
    await recordSend(pool, f.org, f.session, new Date(+agora + 1000), { resposta: true });
    const esperas: number[] = [];
    let durante: number | null = null;
    const r = await responderCom(f, {
      // Sob a trava, o relógio marca 3 s, e fica parado: quem leva o instante à hora da saída é a espera.
      relogio: () => new Date(+agora + 3000),
      sleep: async (ms) => {
        esperas.push(ms);
      },
      send: async () => {
        durante = await ultimaVaga(f);
        return saiu();
      },
    });
    expect(r.status).toBe("sent");
    expect(esperas).toEqual([3000]);
    expect(durante).toBe(+agora + 6000 + FOLGA_DA_IA);
    expect(await ultimaVaga(f)).toBe(+agora + 6000);
  });

  it("controle: em canal sem risco de banimento não há intervalo a medir: o registro fica no instante, e a demora não barra a resposta", async () => {
    const f = await fixture();
    await pool.query("update channel_sessions set provider='meta_cloud', meta_phone_number_id=$1::text where id=$1", [f.session]);
    let relogio = +agora, durante: number | null = null, noEscopo: unknown = "não lido";
    const r = await responderCom(f, {
      pool: comInsertDoRegistro(() => {
        relogio += 60_000;
      }),
      relogio: () => new Date(relogio),
      send: async () => {
        durante = await ultimaVaga(f);
        noEscopo = tomarSaidaDoAgente();
        return saiu();
      },
    });
    expect(r.status).toBe("sent");
    expect(durante).toBe(+agora);
    expect(noEscopo).toBeNull();
    expect(await ultimaVaga(f)).toBe(+agora);
  });

  it("V02 ⭐ a resposta que encontra outra em curso acompanha a linha: sai o intervalo depois de o transporte da anterior voltar, e não a folga inteira", async () => {
    const f = await fixture();
    const entrou = portao(), soltar = portao();
    let relogio = +agora;
    const esperas: number[] = [];
    const primeira = responderCom(f, {
      relogio: () => new Date(relogio),
      send: async () => {
        entrou.abrir();
        await soltar.espera;
        return saiu();
      },
    });
    try {
      await entrou.espera;
      // A 2ª mede com a 1ª ainda no transporte: a linha dela está na hora mais tardia (10 s).
      const segunda = await responderCom(f, {
        relogio: () => new Date(relogio),
        sleep: async (ms) => {
          esperas.push(ms);
          relogio += ms;
          // Na 3ª fatia (1,5 s), o transporte da 1ª volta, e a linha dela recua para essa hora.
          if (esperas.length === 3) {
            soltar.abrir();
            await primeira;
          }
        },
      });
      expect(segunda.status).toBe("sent");
    } finally {
      soltar.abrir();
      await primeira;
    }
    // 1,5 s até a 1ª voltar, e os 5 s do intervalo contados daí: 6,5 s, e não os 15 s da hora mais tardia mais o intervalo.
    expect(soma(esperas)).toBe(6500);
    expect(await ultimaVaga(f)).toBe(+agora + 6500);
    expect(await vagasDoNumero(f)).toBe(61);
  });

  it("V02: se a linha em curso avança durante a espera (o transporte voltou depois da hora mais tardia), o intervalo conta da hora nova", async () => {
    const f = await fixture();
    const entrou = portao(), soltar = portao();
    let relogio = +agora;
    const esperas: number[] = [];
    const primeira = responderCom(f, {
      relogio: () => new Date(relogio),
      send: async () => {
        entrou.abrir();
        await soltar.espera;
        return saiu();
      },
    });
    try {
      await entrou.espera;
      const segunda = await responderCom(f, {
        relogio: () => new Date(relogio),
        sleep: async (ms) => {
          esperas.push(ms);
          relogio += ms;
          // Aos 12 s, 2 s depois da hora mais tardia, o transporte da 1ª volta: a linha dela avança para os 12 s.
          if (esperas.length === 24) {
            soltar.abrir();
            await primeira;
          }
        },
      });
      expect(segunda.status).toBe("sent");
    } finally {
      soltar.abrir();
      await primeira;
    }
    // A 2ª sairia aos 15 s (a hora mais tardia mais o intervalo); com a linha nos 12 s, sai aos 17 s.
    expect(soma(esperas)).toBe(17_000);
    expect(await ultimaVaga(f)).toBe(+agora + 17_000);
  });

  it("V02: a vaga da campanha devolvida durante a espera libera a resposta", async () => {
    const f = await fixture();
    const daCampanha = { limite: null, desde: agora, vagas: 1, intervaloMs: 0, folgaMs: 10_000 };
    expect(await reservarVaga(pool, f.org, f.session, agora, daCampanha)).toBe("reservada");
    let relogio = +agora;
    const esperas: number[] = [];
    const r = await responderCom(f, {
      relogio: () => new Date(relogio),
      sleep: async (ms) => {
        esperas.push(ms);
        relogio += ms;
        // Na 2ª fatia (1 s), a campanha devolve a vaga: o balão não saiu.
        if (esperas.length === 2) await undoSend(pool, f.org, f.session, agora, { folgaMs: 10_000 });
      },
    });
    expect(r.status).toBe("sent");
    // Sem a vaga, a última saída do número é a de uma hora atrás: a resposta sai na hora, 1 s depois de começar a esperar.
    expect(soma(esperas)).toBe(1000);
    expect(await ultimaVaga(f)).toBe(+agora + 1000);
    expect(await vagasDoNumero(f)).toBe(60);
  });

  it("V02: se a vaga devolvida era a única linha do número, a resposta sai na hora: não há saída anterior a respeitar", async () => {
    const f = await fixture();
    await pool.query("delete from pacing_ledger where channel_session_id=$1", [f.session]);
    const daCampanha = { limite: null, desde: agora, vagas: 1, intervaloMs: 0, folgaMs: 10_000 };
    expect(await reservarVaga(pool, f.org, f.session, agora, daCampanha)).toBe("reservada");
    let relogio = +agora;
    const esperas: number[] = [];
    const r = await responderCom(f, {
      relogio: () => new Date(relogio),
      sleep: async (ms) => {
        esperas.push(ms);
        relogio += ms;
        // Na 2ª fatia (1 s), a campanha devolve a vaga, e o número fica sem linha nenhuma.
        if (esperas.length === 2) await undoSend(pool, f.org, f.session, agora, { folgaMs: 10_000 });
      },
    });
    expect(r.status).toBe("sent");
    expect(soma(esperas)).toBe(1000);
    expect(await ultimaVaga(f)).toBe(+agora + 1000);
    expect(await vagasDoNumero(f)).toBe(1);
  });

  it("controle: sem o relógio, a espera do intervalo é uma só, mesmo com a última linha no futuro", async () => {
    const f = await fixture();
    const daCampanha = { limite: null, desde: agora, vagas: 1, intervaloMs: 0, folgaMs: 10_000 };
    expect(await reservarVaga(pool, f.org, f.session, agora, daCampanha)).toBe("reservada");
    const esperas: number[] = [];
    const r = await responderCom(f, {
      relogio: undefined,
      sleep: async (ms) => {
        esperas.push(ms);
      },
    });
    expect(r.status).toBe("sent");
    expect(esperas).toEqual([15_000]);
    expect(await ultimaVaga(f)).toBe(+agora + 15_000);
  });
});

/** A fachada do cxj (F4w, W12): o banco é o de verdade; `depois` roda logo depois de cada releitura da última linha. */
function comReleituraDaUltimaLinha(depois: () => void) {
  return {
    query: pool.query.bind(pool),
    connect: async () => {
      const db = await pool.connect();
      const query = db.query.bind(db);
      return {
        query: async (...args: unknown[]) => {
          const r = await Reflect.apply(query, db, args);
          if (String(args[0]).trim().startsWith("select sent_at from pacing_ledger")) depois();
          return r;
        },
        release: db.release.bind(db),
      };
    },
  } as unknown as pg.Pool;
}

describe("versão 18 — a espera que acompanha a linha conta o tempo das releituras (F4w do cxj, W12)", () => {
  /** O número com intervalo de 1,2 s e uma saída em curso com a hora mais tardia aos 10 s: a resposta sai aos 11,2 s. */
  async function comSaidaEmCurso() {
    const f = await fixture();
    await pool.query("update channel_knobs set throttle_ms=1200 where channel_session_id=$1", [f.session]);
    await recordSend(pool, f.org, f.session, new Date(+agora + 10_000), { resposta: true });
    return f;
  }

  it("W12 ⭐ (cxj) com releituras de 1 s, a espera termina quando o intervalo passou, e não 23 releituras depois", async () => {
    const f = await comSaidaEmCurso();
    let relogio = +agora, leituras = 0, dormiu = 0;
    const r = await responderCom(f, {
      pool: comReleituraDaUltimaLinha(() => {
        leituras++;
        relogio += 1000;
      }),
      relogio: () => new Date(relogio),
      sleep: async (ms) => {
        dormiu += ms;
        relogio += ms;
      },
    });
    expect(r.status).toBe("sent");
    // Cada fatia de 500 ms custa mais 1 s de releitura: a 8ª termina aos 12 s, a primeira depois dos 11,2 s.
    expect(dormiu).toBe(4000);
    expect(leituras).toBe(8);
    expect(relogio - +agora).toBe(12_000);
    expect(await ultimaVaga(f)).toBe(+agora + 12_000);
  });

  it("o tempo que a espera contou vale no registro: se o relógio recua logo depois dela, a linha não fica a menos do intervalo", async () => {
    const f = await comSaidaEmCurso();
    let relogio = +agora, leituras = 0, lidoDepoisDaEspera = 0;
    const r = await responderCom(f, {
      pool: comReleituraDaUltimaLinha(() => {
        leituras++;
        relogio += 1000;
      }),
      // A espera termina na 8ª releitura, com o relógio nos 12 s; quem o lê depois dela já o acha nos 5 s.
      relogio: () => new Date(leituras === 8 && lidoDepoisDaEspera++ > 0 ? +agora + 5000 : relogio),
      sleep: async (ms) => {
        relogio += ms;
      },
    });
    expect(r.status).toBe("sent");
    expect(leituras).toBe(8);
    // A última linha do número estava nos 10 s, e o intervalo é de 1,2 s: o registro não pode ficar antes dos 11,2 s.
    expect(await ultimaVaga(f)).toBe(+agora + 12_000);
  });

  it("controle: com o relógio parado, a espera conta pela soma das fatias, e termina", async () => {
    const f = await comSaidaEmCurso();
    let leituras = 0;
    const esperas: number[] = [];
    const r = await responderCom(f, {
      pool: comReleituraDaUltimaLinha(() => {
        leituras++;
      }),
      sleep: async (ms) => {
        esperas.push(ms);
      },
    });
    expect(r.status).toBe("sent");
    expect(soma(esperas)).toBe(11_200);
    expect(leituras).toBe(23);
    expect(await ultimaVaga(f)).toBe(+agora + 11_200);
  });
});
