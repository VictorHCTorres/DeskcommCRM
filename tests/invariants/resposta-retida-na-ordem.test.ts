/**
 * A RESPOSTA RETIDA NÃO É ULTRAPASSADA, DE PONTA A PONTA NO POSTGRES (F4w do cxj, 12/11/2026, W02; versão 18).
 *
 * Na versão 17, a resposta do agente mais velha do que a folga no último passo do handler fica na fila (`queued`). O
 * turno segue, e a resposta seguinte, com outro registro, saía na hora: a retida chegava depois dela, pelo resgate do
 * watchdog (W02 do cxj: “Primeira” vence, “Segunda” sai, o resgate entrega “Primeira”).
 *
 * Aqui nada é dublê do produto: a cadeia do agente (`runBeforeSend`, com o portão do ritmo), o canal do agente
 * (`WahaChannelAdapter`), o envio do turno e o ledger (`sendTurnMessage`), o handler de envio (`sendMessageHandler`,
 * sobre o Postgres, por `pgComoSupabase`) e o resgate (`redriveQueued`). De fora, só o relógio e o provedor: o `fetch`
 * anota o que chegou a ele, na ordem, venha do handler ou do resgate.
 *
 * A regra da versão 18: nenhum texto do agente sai enquanto houver, na mesma conversa, uma resposta do agente retida e
 * mais antiga (por idade, ou por ordem). No handler, o texto espera atrás dela (`atras_de_resposta_retida`); no
 * resgate, a mensagem que tem uma resposta retida mais antiga na conversa fica para o tique seguinte.
 *
 * A versão 19 (F4x do cxj, X01 e X08): a marca de resposta nasce com a mensagem, e a ordem conta a resposta do agente
 * que ainda está na fila, com qualquer motivo, ou sem nenhum. Na 18, a marca era gravada só na retenção (se a gravação
 * falhasse, a linha ficava fora da ordem: X01), e a ordem pedia um dos dois motivos da cadeia (a nova tentativa com o
 * canal fora do ar trocava o motivo, e a retida deixava de segurar a seguinte: X08).
 *
 * A metade do handler, com o dublê, está em `tests/unit/resposta-retida-espera-no-handler.test.ts`; a consulta
 * sozinha, em `tests/invariants/resposta-retida-consulta.test.ts`.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WahaChannelAdapter } from "@/lib/agent-engine/edge/channel/waha-adapter";
import {
  ATRASO_MAXIMO_DA_VAGA_DO_RESGATE_MS as FOLGA_DO_RESGATE,
  redriveQueued,
} from "@/lib/agent-engine/edge/crm/session-reconciler";
import { pacingGate, runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import {
  ATRASO_MAXIMO_DA_SAIDA_DO_AGENTE_MS as FOLGA_DA_IA,
  saidaDoAgenteNoEscopo,
} from "@/lib/agent-engine/pacing/saida-do-agente";
import { recordSend } from "@/lib/agent-engine/pacing/store";
import { readCurrentServiceBoundary } from "@/lib/atendimento/fronteira-server";

import { pgComoSupabase } from "../pg-como-supabase";

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

const agora = new Date("2026-11-18T14:00:00Z");
const INTERVALO = 5000;
/**
 * O tique seguinte do resgate em que cabe outra mensagem no mesmo número: a vaga dele fica na hora mais tardia da saída
 * (o instante mais a folga), e a reserva seguinte pede o intervalo mais a folga a partir dela.
 */
const TIQUE_SEGUINTE = INTERVALO + 2 * FOLGA_DO_RESGATE;
const cfg = { wahaBaseUrl: "http://teste.invalid", wahaApiKey: "ficticio", intervalMs: 1000, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0 };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/** O relógio da cadeia, do handler e do resgate; o que chegou ao provedor, na ordem; e os textos que ele recusa. */
let relogio = +agora;
const saidas: string[] = [];
const recusadas = new Set<string>();
/** Roda enquanto o texto está no provedor, antes de ele aceitar: é o envio em curso. */
let noProvedor: ((texto: string) => Promise<void>) | null = null;
beforeEach(() => {
  relogio = +agora;
  saidas.length = 0;
  recusadas.clear();
  noProvedor = null;
  vi.stubEnv("WAHA_API_BASE_URL", "http://127.0.0.1:3030");
  vi.stubEnv("WAHA_API_KEY", "ficticia");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).endsWith("/sendText")) {
        const texto = String(JSON.parse(String(init?.body ?? "{}")).text);
        if (recusadas.has(texto)) return new Response("recusada", { status: 400 });
        await noProvedor?.(texto);
        saidas.push(texto);
      }
      return Response.json({ id: { id: `FICTICIA-${randomUUID()}` } });
    }),
  );
});
// O resgate é global: o que ficar `queued` de um teste não pode ir para o tique do seguinte.
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await pool.query("update messages set status='failed' where status='queued'");
});

interface Turno {
  job: string;
  jobClaim: { worker_id: string; acquired_at: string };
}
/** Um job de resposta em execução, com a fronteira atual da conversa e o dono do turno, como o worker o deixa. */
async function novoTurno(f: { org: string; contact: string; conversa: string }, kind = "inbound_turn"): Promise<Turno> {
  const fronteira = await readCurrentServiceBoundary(pool, f.org, f.conversa);
  const limite = {
    organization_id: f.org,
    contact_id: f.contact,
    conversation_id: f.conversa,
    service_revision: Number(fronteira!.service_revision),
    demanda_id: fronteira!.demanda_id ?? null,
    demanda_revision: fronteira!.demanda_revision ?? null,
  };
  const job = randomUUID();
  const { rows } = await pool.query<{ locked_at: string }>(
    "insert into job_queue(id,organization_id,contact_id,kind,status,locked_by,locked_at,payload) values($1,$2,$3,$4,'running','teste',now(),$5::jsonb) returning locked_at::text",
    [job, f.org, f.contact, kind, JSON.stringify({ service_boundary: limite })],
  );
  return { job, jobClaim: { worker_id: "teste", acquired_at: rows[0]!.locked_at } };
}
const terminar = (turno: Turno) => pool.query("update job_queue set status='done', locked_by=null, locked_at=null where id=$1", [turno.job]);
/** O job que falhou e espera a nova tentativa: vivo, sem dono. */
const devolverAFila = (turno: Turno) =>
  pool.query("update job_queue set status='pending', locked_by=null, locked_at=null where id=$1", [turno.job]);

async function fixture() {
  const org = randomUUID(), contact = randomUUID(), session = randomUUID(), conversa = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,'Teste da ordem','Teste da ordem','America/Sao_Paulo')",
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
  await pool.query(
    "insert into channel_knobs(organization_id,channel_session_id,throttle_ms,jitter_max_ms,warmup_daily_caps) values($1,$2,$3,0,$4::jsonb)",
    [org, session, INTERVALO, JSON.stringify([{ minAgeDays: 0, cap: null }])],
  );
  await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')", [
    conversa,
    org,
    contact,
    session,
  ]);
  for (let i = 0; i < 59; i++) await recordSend(pool, org, session, new Date(+agora - 3600000 + i));
  const base = { org, contact, session, conversa };
  return { ...base, turno: await novoTurno(base) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** O cliente do handler, sobre o Postgres; `aoGravar` roda logo antes de o handler gravar a mensagem. */
function supabaseDoHandler(aoGravar: () => void): SupabaseClient {
  const base = pgComoSupabase(pool) as unknown as {
    from: (tabela: string) => Record<string, unknown> & { insert: (linha: Record<string, unknown>) => unknown };
    rpc: unknown;
  };
  return {
    from(tabela: string) {
      const consulta = base.from(tabela);
      if (tabela !== "messages") return consulta;
      return {
        ...consulta,
        insert: (linha: Record<string, unknown>) => {
          aoGravar();
          return consulta.insert(linha);
        },
      };
    },
    rpc: base.rpc,
  } as unknown as SupabaseClient;
}

interface Opcoes {
  /** Quanto o relógio anda entre o registro da cadeia e o último passo do handler (a espera do banco, por exemplo). */
  atrasoNoHandler?: number;
  resposta?: boolean;
  /** Roda dentro do transporte, antes do envio do turno: o que o handler vai achar no escopo. */
  noTransporte?: () => void | Promise<void>;
}
/** A resposta `seq` do turno, pela cadeia e pelo canal do agente de verdade. */
function responder(f: Fixture, turno: Turno, seq: number, body: string, opcoes: Opcoes = {}) {
  let atraso = opcoes.atrasoNoHandler ?? 0;
  const canal = new WahaChannelAdapter(pool, {
    supabase: supabaseDoHandler(() => {
      relogio += atraso;
      atraso = 0;
    }),
  });
  return runBeforeSend({
    pool,
    log,
    tenantId: f.org,
    leadId: f.contact,
    jobId: turno.job,
    channelSessionId: f.session,
    body,
    optedOutThisTurn: false,
    crmDailyLimit: 60,
    now: new Date(relogio),
    relogio: () => new Date(relogio),
    rng: () => 0,
    sleep: async (ms) => {
      relogio += ms;
    },
    gates: [pacingGate],
    enforceSpinning: false,
    resposta: opcoes.resposta ?? true,
    send: async (corpo) => {
      await opcoes.noTransporte?.();
      return canal.send({
        tenantId: f.org,
        leadId: f.contact,
        jobId: turno.job,
        seq,
        conversationId: f.conversa,
        body: corpo,
        jobClaim: turno.jobClaim,
      });
    },
  });
}
const tique = () => redriveQueued(pool, cfg, log, undefined, () => new Date(relogio));
const vagasDoNumero = async (f: Fixture) =>
  Number((await pool.query("select count(*) n from pacing_ledger where channel_session_id=$1", [f.session])).rows[0].n);
/** As mensagens da conversa, da mais antiga para a mais nova: o texto, o estado e o que a retenção gravou. */
async function mensagens(f: Fixture) {
  const { rows } = await pool.query<{ body: string; status: string; motivo: string | null; resposta: string | null }>(
    `select body, status, metadata->>'queued_reason' as motivo, metadata->>'queued_resposta' as resposta
       from messages where conversation_id=$1 order by created_at, id`,
    [f.conversa],
  );
  return rows.map((r) => [r.body, r.status, r.motivo, r.resposta]);
}
/** Uma mensagem da IA presa na fila por outro caminho (o canal fora do ar), sem job: nasce agora, depois das outras. */
async function presaSemJob(f: Fixture, body: string) {
  const id = randomUUID();
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,metadata)
     values($1,$2,$3,$4,$5,'outbound','text',$6,'queued','ai','{"queued_reason":"channel_session_not_working"}')`,
    [id, f.org, f.conversa, f.contact, f.session, body],
  );
  return id;
}

/** O estado da sessão do canal: fora de `WORKING`, o handler deixa a mensagem na fila antes de qualquer corte. */
const sessao = (f: Fixture, status: "WORKING" | "STOPPED") =>
  pool.query("update channel_sessions set status=$2 where id=$1", [f.session, status]);
/**
 * O banco recusa toda gravação de `messages` que leve este motivo (a queda que o X01 do cxj injeta), até `desfazer`.
 * As outras consultas passam.
 */
function recusarGravacaoDoMotivo(motivo: string) {
  let recusas = 0;
  const consultar = pool.query.bind(pool);
  const espia = vi.spyOn(pool, "query").mockImplementation((async (...args: unknown[]) => {
    if (String(args[0]).startsWith('update public."messages"') && JSON.stringify(args[1] ?? []).includes(motivo)) {
      recusas++;
      throw new Error("gravação recusada (fictícia)");
    }
    return Reflect.apply(consultar, pool, args);
  }) as typeof pool.query);
  return { recusas: () => recusas, desfazer: () => espia.mockRestore() };
}

describe("versão 18 — a resposta retida não é ultrapassada (F4w do cxj, W02)", () => {
  it("⭐ W02/W11 do cxj, de ponta a ponta: a “Segunda” espera atrás da “Primeira”, e o resgate entrega as duas na ordem", async () => {
    const f = await fixture();
    // A “Primeira” passa pela cadeia e vence no último passo do handler: fica na fila, e o registro dela volta.
    expect(await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 })).toMatchObject({
      outcome: { kind: "queued" },
    });
    // A “Segunda”, com a saída em dia, não chega ao provedor: espera atrás da “Primeira”, e o registro dela também volta.
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "queued" } });
    expect(saidas).toEqual([]);
    expect(await vagasDoNumero(f)).toBe(59);
    expect(await mensagens(f)).toEqual([
      ["Primeira", "queued", "saida_do_agente_vencida", "true"],
      ["Segunda", "queued", "atras_de_resposta_retida", "true"],
    ]);
    // O turno acabou. O resgate manda uma por tique, na ordem: a “Segunda” só depois de a “Primeira” sair.
    await terminar(f.turno);
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira"]);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira", "Segunda"]);
    expect(await vagasDoNumero(f)).toBe(61);
    expect((await mensagens(f)).map((m) => m[1])).toEqual(["sent", "sent"]);
  });

  it("no mesmo tique, com vaga para as duas, o resgate ainda manda só a mais antiga", async () => {
    const f = await fixture();
    await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 });
    await responder(f, f.turno, 2, "Segunda");
    await terminar(f.turno);
    // Sem intervalo no número, a vaga não segura ninguém: quem segura a “Segunda” é a ordem.
    await pool.query("update channel_knobs set throttle_ms=0 where channel_session_id=$1", [f.session]);
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira"]);
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira", "Segunda"]);
  });

  it("⭐ a nova tentativa do job manda a retida pelo mesmo id, e só depois a que esperava; o resgate não toma nenhuma", async () => {
    const f = await fixture();
    await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 });
    await responder(f, f.turno, 2, "Segunda");
    // O job segue vivo: as duas são dele.
    expect(await tique()).toBe(0);
    // Fora de ordem, a nova tentativa não passa: a “Segunda” continua esperando.
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "queued" } });
    expect(saidas).toEqual([]);
    expect(await responder(f, f.turno, 1, "Primeira")).toMatchObject({ outcome: { kind: "sent" } });
    relogio += INTERVALO;
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "sent" } });
    expect(saidas).toEqual(["Primeira", "Segunda"]);
    // Uma linha por mensagem: a retomada usou o mesmo id.
    expect(await mensagens(f)).toEqual([
      ["Primeira", "sent", "saida_do_agente_vencida", "true"],
      ["Segunda", "sent", "atras_de_resposta_retida", "true"],
    ]);
    expect(await vagasDoNumero(f)).toBe(61);
  });

  it("⭐ a resposta de outro turno, na mesma conversa, também espera atrás da retida", async () => {
    const f = await fixture();
    await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 });
    await terminar(f.turno);
    // A pessoa escreveu de novo antes do tique do resgate: o turno seguinte responde.
    const seguinte = await novoTurno(f);
    expect(await responder(f, seguinte, 1, "Terceira")).toMatchObject({ outcome: { kind: "queued" } });
    expect(saidas).toEqual([]);
    await terminar(seguinte);
    expect(await tique()).toBe(1);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira", "Terceira"]);
  });

  it("⭐ o resgate não manda a mensagem mais nova enquanto a resposta retida mais antiga está com um job vivo", async () => {
    const f = await fixture();
    await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 });
    // O job da “Primeira” falhou depois dela e espera a nova tentativa: a mensagem segue sendo dele.
    await devolverAFila(f.turno);
    // Outra mensagem da IA, mais nova, presa na fila por outro caminho e sem job: o resgate poderia mandá-la.
    await presaSemJob(f, "Mais nova");
    expect(await tique()).toBe(0);
    expect(saidas).toEqual([]);
    // O job terminou sem mandar a “Primeira”: agora ela é do resgate, e sai antes da mais nova.
    await terminar(f.turno);
    expect(await tique()).toBe(1);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira", "Mais nova"]);
  });

  it("a releitura do resgate também confere a ordem: a resposta mais antiga que ficou retida depois da seleção segura a mais nova", async () => {
    const f = await fixture();
    // Uma resposta mais antiga, ainda em curso quando o resgate seleciona (`sent` na leitura dele).
    const antiga = randomUUID();
    await pool.query(
      `insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,created_at,metadata)
       values($1,$2,$3,$4,$5,'outbound','text','Antiga','sent','ai',now()-interval '5 minutes','{}')`,
      [antiga, f.org, f.conversa, f.contact, f.session],
    );
    await terminar(f.turno);
    await presaSemJob(f, "Mais nova");
    // Entre a seleção e a releitura da elegibilidade, a antiga fica retida.
    let releituras = 0;
    const fachada = {
      connect: pool.connect.bind(pool),
      query: async (...args: unknown[]) => {
        if (String(args[0]).includes("fn_org_operante") && ++releituras === 1) {
          await pool.query(
            `update messages set status='queued', metadata='{"queued_reason":"saida_do_agente_vencida","queued_resposta":true}' where id=$1`,
            [antiga],
          );
        }
        return Reflect.apply(pool.query, pool, args);
      },
    } as unknown as pg.Pool;
    expect(await redriveQueued(fachada, cfg, log, undefined, () => new Date(relogio))).toBe(0);
    expect(releituras).toBe(1);
    expect(saidas).toEqual([]);
  });

  it("⭐ a validade preserva o atendimento: a retida que não sai em 10 minutos deixa de segurar a conversa", async () => {
    const f = await fixture();
    await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 });
    await terminar(f.turno);
    // O provedor recusa a “Primeira”, e só ela: o resgate tenta a cada tique, e ela segue na fila.
    recusadas.add("Primeira");
    expect(await tique()).toBe(0);
    // Enquanto ela vale, a resposta seguinte espera atrás dela, e o resgate não a manda.
    const segundo = await novoTurno(f);
    expect(await responder(f, segundo, 1, "Segunda")).toMatchObject({ outcome: { kind: "queued" } });
    await terminar(segundo);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(0);
    expect(saidas).toEqual([]);
    // Passados os 10 minutos, a “Primeira” deixa de segurar: o resgate manda a “Segunda”, e a resposta nova sai na hora.
    await pool.query("update messages set created_at = created_at - interval '11 minutes' where conversation_id=$1 and body='Primeira'", [
      f.conversa,
    ]);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Segunda"]);
    const terceiro = await novoTurno(f);
    expect(await responder(f, terceiro, 1, "Terceira")).toMatchObject({ outcome: { kind: "sent" } });
    expect(saidas).toEqual(["Segunda", "Terceira"]);
    expect((await mensagens(f)).map((m) => [m[0], m[1]])).toEqual([
      ["Primeira", "queued"],
      ["Segunda", "sent"],
      ["Terceira", "sent"],
    ]);
  });

  it("a retida por idade que não é resposta não segura a resposta seguinte (ela não espera um envio com teto e janela)", async () => {
    const f = await fixture();
    expect(
      await responder(f, f.turno, 1, "Retorno", { atrasoNoHandler: FOLGA_DA_IA + 1, resposta: false }),
    ).toMatchObject({ outcome: { kind: "queued" } });
    expect(await mensagens(f)).toEqual([["Retorno", "queued", "saida_do_agente_vencida", null]]);
    expect(await responder(f, f.turno, 2, "Resposta")).toMatchObject({ outcome: { kind: "sent" } });
    expect(saidas).toEqual(["Resposta"]);
  });

  it("controle: sem resposta retida, duas respostas seguidas saem pela cadeia, na ordem e com o intervalo", async () => {
    const f = await fixture();
    expect(await responder(f, f.turno, 1, "Primeira")).toMatchObject({ outcome: { kind: "sent" } });
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "sent" } });
    expect(saidas).toEqual(["Primeira", "Segunda"]);
    expect(relogio - +agora).toBe(INTERVALO);
    expect((await mensagens(f)).map((m) => [m[1], m[2]])).toEqual([
      ["sent", null],
      ["sent", null],
    ]);
  });
});

describe("versão 18 — a ordem no escopo que a cadeia entrega ao transporte", () => {
  it("com o relógio e intervalo no número, o transporte acha a ordem: se o envio é resposta, e a pergunta, que lê o banco", async () => {
    const f = await fixture();
    await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 });
    const { rows } = await pool.query<{ id: string }>("select id from messages where conversation_id=$1", [f.conversa]);
    const nova = await presaSemJob(f, "Mais nova");
    const achado: Array<{ resposta: boolean; antes: boolean; aPropria: boolean }> = [];
    for (const resposta of [true, false]) {
      await responder(f, f.turno, resposta ? 2 : 3, "Outra", {
        resposta,
        noTransporte: async () => {
          const ordem = saidaDoAgenteNoEscopo()!.ordem!;
          achado.push({
            resposta: ordem.resposta,
            antes: await ordem.haRespostaRetidaAntes({ conversationId: f.conversa, messageId: nova }),
            aPropria: await ordem.haRespostaRetidaAntes({ conversationId: f.conversa, messageId: rows[0]!.id }),
          });
        },
      });
    }
    expect(achado).toEqual([
      { resposta: true, antes: true, aPropria: false },
      { resposta: false, antes: true, aPropria: false },
    ]);
  });

  it("controle: sem intervalo no número, não há saída no escopo, nem ordem", async () => {
    const f = await fixture();
    await pool.query("update channel_knobs set throttle_ms=0 where channel_session_id=$1", [f.session]);
    let noEscopo: unknown = "não rodou";
    await responder(f, f.turno, 1, "Primeira", {
      noTransporte: () => {
        noEscopo = saidaDoAgenteNoEscopo();
      },
    });
    expect(noEscopo).toBeNull();
    expect(saidas).toEqual(["Primeira"]);
  });
});

describe("versão 19 — a marca nasce com a resposta, e a ordem não depende do motivo (F4x do cxj, X01 e X08)", () => {
  it("⭐ X01 do cxj: a gravação do motivo falha, e a resposta posterior ainda espera atrás da retida", async () => {
    const f = await fixture();
    const queda = recusarGravacaoDoMotivo("saida_do_agente_vencida");
    expect(await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 })).toMatchObject({
      outcome: { kind: "queued" },
    });
    // O motivo não gravou: a linha segue na fila sem ele, e com a marca, que nasceu com ela.
    expect(await mensagens(f)).toEqual([["Primeira", "queued", null, "true"]]);
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "queued" } });
    expect(saidas).toEqual([]);
    expect(await mensagens(f)).toEqual([
      ["Primeira", "queued", null, "true"],
      ["Segunda", "queued", "atras_de_resposta_retida", "true"],
    ]);
    // Duas tentativas de gravar o motivo, as duas recusadas.
    expect(queda.recusas()).toBe(2);
    queda.desfazer();
    await terminar(f.turno);
    expect(await tique()).toBe(1);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira", "Segunda"]);
  });

  it("⭐ X08 do cxj: a nova tentativa com o canal fora do ar troca o motivo da retida, e ela segue segurando a seguinte", async () => {
    const f = await fixture();
    await responder(f, f.turno, 1, "Primeira", { atrasoNoHandler: FOLGA_DA_IA + 1 });
    expect(await mensagens(f)).toEqual([["Primeira", "queued", "saida_do_agente_vencida", "true"]]);
    await sessao(f, "STOPPED");
    expect(await responder(f, f.turno, 1, "Primeira")).toMatchObject({ outcome: { kind: "queued" } });
    expect(await mensagens(f)).toEqual([["Primeira", "queued", "channel_session_not_working", "true"]]);
    await sessao(f, "WORKING");
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "queued" } });
    expect(saidas).toEqual([]);
    await terminar(f.turno);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira", "Segunda"]);
  });

  it("⭐ a resposta que ficou na fila pelo canal fora do ar, desde o começo, segura a seguinte, e o resgate entrega as duas na ordem", async () => {
    const f = await fixture();
    await sessao(f, "STOPPED");
    expect(await responder(f, f.turno, 1, "Primeira")).toMatchObject({ outcome: { kind: "queued" } });
    expect(await mensagens(f)).toEqual([["Primeira", "queued", "channel_session_not_working", "true"]]);
    // O canal volta (a reconexão de 1 s a 2 s), e o turno segue: a resposta seguinte não passa na frente.
    await sessao(f, "WORKING");
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "queued" } });
    expect(saidas).toEqual([]);
    expect(await mensagens(f)).toEqual([
      ["Primeira", "queued", "channel_session_not_working", "true"],
      ["Segunda", "queued", "atras_de_resposta_retida", "true"],
    ]);
    await terminar(f.turno);
    expect(await tique()).toBe(1);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira", "Segunda"]);
  });

  it("controle: de volta o canal, a nova tentativa do job manda a resposta pelo mesmo id (ela não segura a si mesma), e a seguinte sai pela cadeia", async () => {
    const f = await fixture();
    await sessao(f, "STOPPED");
    await responder(f, f.turno, 1, "Primeira");
    await sessao(f, "WORKING");
    expect(await responder(f, f.turno, 1, "Primeira")).toMatchObject({ outcome: { kind: "sent" } });
    relogio += INTERVALO;
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "sent" } });
    expect(saidas).toEqual(["Primeira", "Segunda"]);
    expect((await mensagens(f)).map((m) => [m[0], m[1], m[3]])).toEqual([
      ["Primeira", "sent", "true"],
      ["Segunda", "sent", "true"],
    ]);
  });

  it("⭐ a resposta ainda em curso (gravada, e ainda no provedor) já segura a seguinte: o corte deixa de ser uma corrida", async () => {
    const f = await fixture();
    let outro: Turno | null = null;
    let segunda: unknown = "não rodou";
    noProvedor = async (texto) => {
      if (texto !== "Primeira") return;
      noProvedor = null;
      // A “Primeira” está no provedor, que demora. O job dela perde a vez (o banco só deixa um job do contato rodar de
      // cada vez: `uniq_job_queue_one_running_per_contact`), e o turno seguinte da conversa chega ao corte dele.
      await devolverAFila(f.turno);
      outro = await novoTurno(f);
      segunda = await responder(f, outro, 1, "Segunda");
    };
    expect(await responder(f, f.turno, 1, "Primeira")).toMatchObject({ outcome: { kind: "sent" } });
    expect(segunda).toMatchObject({ outcome: { kind: "queued" } });
    expect(saidas).toEqual(["Primeira"]);
    expect(await mensagens(f)).toEqual([
      ["Primeira", "sent", null, "true"],
      ["Segunda", "queued", "atras_de_resposta_retida", "true"],
    ]);
    // O turno seguinte termina, e o resgate entrega a que esperou.
    await terminar(outro!);
    relogio += TIQUE_SEGUINTE;
    expect(await tique()).toBe(1);
    expect(saidas).toEqual(["Primeira", "Segunda"]);
  });

  it("⭐ a resposta que nasceu sem a marca (antes desta versão) a ganha na nova tentativa do job, e passa a segurar a seguinte", async () => {
    const f = await fixture();
    await sessao(f, "STOPPED");
    await responder(f, f.turno, 1, "Primeira");
    // Como a linha de antes desta versão: na fila, sem a marca.
    await pool.query("update messages set metadata = metadata - 'queued_resposta' where conversation_id=$1", [f.conversa]);
    expect(await mensagens(f)).toEqual([["Primeira", "queued", "channel_session_not_working", null]]);
    // A nova tentativa do job, ainda com o canal fora do ar: a marca entra antes de qualquer saída.
    expect(await responder(f, f.turno, 1, "Primeira")).toMatchObject({ outcome: { kind: "queued" } });
    expect(await mensagens(f)).toEqual([["Primeira", "queued", "channel_session_not_working", "true"]]);
    await sessao(f, "WORKING");
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "queued" } });
    expect(saidas).toEqual([]);
  });

  it("controle: a resposta que o provedor recusa vira falha, e não segura a seguinte", async () => {
    const f = await fixture();
    recusadas.add("Primeira");
    await responder(f, f.turno, 1, "Primeira");
    expect((await mensagens(f)).map((m) => [m[0], m[1], m[3]])).toEqual([["Primeira", "failed", "true"]]);
    relogio += INTERVALO + FOLGA_DA_IA;
    expect(await responder(f, f.turno, 2, "Segunda")).toMatchObject({ outcome: { kind: "sent" } });
    expect(saidas).toEqual(["Segunda"]);
  });

  it("controle: o envio do agente que não é resposta nasce sem a marca, e na fila pelo canal fora do ar não segura a resposta seguinte", async () => {
    const f = await fixture();
    await sessao(f, "STOPPED");
    await responder(f, f.turno, 1, "Retorno", { resposta: false });
    expect(await mensagens(f)).toEqual([["Retorno", "queued", "channel_session_not_working", null]]);
    await sessao(f, "WORKING");
    expect(await responder(f, f.turno, 2, "Resposta")).toMatchObject({ outcome: { kind: "sent" } });
    expect(saidas).toEqual(["Resposta"]);
  });
});
