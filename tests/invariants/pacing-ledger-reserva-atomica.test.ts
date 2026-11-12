import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ESPERA_PELA_TRAVA_MS, recordSend, reservarVaga, type RegraDaVaga } from "@/lib/agent-engine/pacing/store";

/**
 * A RESERVA ATÔMICA DA VAGA (revisão F4n do cxj, 11/11/2026, N12).
 *
 * Duas rodadas de campanha sobrepostas liam o mesmo saldo do número (59 de 60) e
 * as duas mandavam: a leitura do teto (`loadPacingState`) e a gravação da vaga
 * (`recordSend`) eram passos separados, e o INSERT não conferia nada. A F4n do cxj
 * provou 61 saídas e 61 linhas no Postgres real.
 *
 * `reservarVaga` confere e grava numa transação só, sob o MESMO
 * `pg_advisory_xact_lock(hashtext(número))` da cadeia do agente (`before-send.ts`,
 * INBOX-008): quem chega depois espera a vez e relê o ledger já com a vaga de
 * quem passou. O que este arquivo prova, contra o schema real e com conexões de
 * verdade disputando a mesma vaga:
 * - só cabe no teto o que o teto comporta, por mais reservas que cheguem juntas;
 * - a trava é a do agente: com o número preso por outra transação, a reserva
 *   espera e conta o que ela gravou;
 * - a resposta não gasta o teto, mas conta no intervalo, como em `loadPacingState`;
 * - o teto é do dia, do número e da organização;
 * - o 1º balão só sai se couberem todos;
 * - a vaga reservada segura o intervalo da seguinte, mesmo com as duas juntas;
 * - a espera pela trava tem limite (o pedido, ou o padrão de 15 s) e não sobra
 *   na conexão que volta ao pool;
 * - o erro do banco não grava nada e não deixa a conexão presa.
 */

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 12,
});

const org = randomUUID();
const outraOrg = randomUUID();
const DESDE = new Date("2026-11-18T03:00:00Z"); // meia-noite de 18/11 em São Paulo
const AGORA = new Date("2026-11-18T14:00:00Z"); // 11h
const TETO: RegraDaVaga = { limite: 60, desde: DESDE, vagas: 1, intervaloMs: 0 };

async function novoNumero(dona = org): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted)
     values($1,$2,'waha',$3,'WORKING','\\x00'::bytea)`,
    [id, dona, `reserva-${id.slice(0, 8)}`],
  );
  return id;
}

/** `n` disparos do número, um por minuto, a partir das 8h do dia. */
async function disparos(numero: string, n: number, dona = org, base = new Date("2026-11-18T11:00:00Z")) {
  for (let i = 0; i < n; i++) await recordSend(pool, dona, numero, new Date(base.getTime() + i * 60_000));
}

async function doDia(numero: string, dona = org): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    `select count(*)::int as n from pacing_ledger
      where organization_id = $1 and channel_session_id = $2 and sent_at >= $3 and not resposta`,
    [dona, numero, DESDE],
  );
  return rows[0]!.n;
}

/** Prende o número como a cadeia do agente prende: transação aberta com a trava na mão. */
async function prenderONumero(numero: string) {
  const agente = await pool.connect();
  await agente.query("begin");
  await agente.query("select pg_advisory_xact_lock(hashtext($1))", [numero]);
  return agente;
}

const esperar = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

beforeAll(async () => {
  for (const id of [org, outraOrg]) {
    await pool.query(
      `insert into organizations(id,slug,legal_name,display_name,timezone)
       values($1::uuid,$1::text,'Teste Reserva','Teste Reserva','America/Sao_Paulo')`,
      [id],
    );
  }
});
afterAll(() => pool.end());

describe("a reserva da vaga no schema real", () => {
  it("oito reservas juntas pela última vaga: só uma entra, e o ledger fecha em 60", async () => {
    for (let volta = 0; volta < 5; volta++) {
      const numero = await novoNumero();
      await disparos(numero, 59);
      const resultados = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          reservarVaga(pool, org, numero, new Date(AGORA.getTime() + i), TETO),
        ),
      );
      expect(resultados.filter((r) => r === "reservada")).toHaveLength(1);
      expect(resultados.filter((r) => r === "teto_cheio")).toHaveLength(7);
      expect(await doDia(numero)).toBe(60);
    }
  });

  it("com três vagas livres e oito reservas juntas, entram três", async () => {
    const numero = await novoNumero();
    await disparos(numero, 57);
    const resultados = await Promise.all(
      Array.from({ length: 8 }, (_, i) => reservarVaga(pool, org, numero, new Date(AGORA.getTime() + i), TETO)),
    );
    expect(resultados.filter((r) => r === "reservada")).toHaveLength(3);
    expect(await doDia(numero)).toBe(60);
  });

  it("a trava é a do agente: com o número preso, a reserva espera e conta o envio que ele gravou", async () => {
    const numero = await novoNumero();
    await disparos(numero, 59);
    const agente = await prenderONumero(numero);
    let fechada = false;
    try {
      // O agente manda a 60ª e grava, ainda com a trava na mão.
      await agente.query(
        `insert into pacing_ledger (organization_id, channel_session_id, sent_at, resposta) values ($1,$2,$3,false)`,
        [org, numero, AGORA],
      );
      let resolvida = false;
      const reservas = Array.from({ length: 4 }, (_, i) =>
        reservarVaga(pool, org, numero, new Date(AGORA.getTime() + 1000 + i), TETO).finally(() => {
          resolvida = true;
        }),
      );
      await esperar(400);
      expect(resolvida).toBe(false);
      await agente.query("commit");
      fechada = true;
      const resultados = await Promise.all(reservas);
      expect(resultados).toEqual(["teto_cheio", "teto_cheio", "teto_cheio", "teto_cheio"]);
    } finally {
      if (!fechada) await agente.query("rollback").catch(() => undefined);
      agente.release(!fechada);
    }
    expect(await doDia(numero)).toBe(60);
  });

  it("a trava é por número: a reserva de outro número não espera", async () => {
    const preso = await novoNumero();
    const livre = await novoNumero();
    const agente = await prenderONumero(preso);
    try {
      const resultado = await Promise.race([
        reservarVaga(pool, org, livre, AGORA, TETO),
        esperar(2000).then(() => "esperou" as const),
      ]);
      expect(resultado).toBe("reservada");
    } finally {
      await agente.query("rollback").catch(() => undefined);
      agente.release(true);
    }
  });

  it("a resposta não gasta o teto do dia", async () => {
    const numero = await novoNumero();
    await disparos(numero, 59);
    for (let i = 0; i < 5; i++) {
      await recordSend(pool, org, numero, new Date(AGORA.getTime() - 60_000 + i), { resposta: true });
    }
    expect(await reservarVaga(pool, org, numero, AGORA, TETO)).toBe("reservada");
    expect(await reservarVaga(pool, org, numero, new Date(AGORA.getTime() + 1), TETO)).toBe("teto_cheio");
  });

  it("o intervalo conta do último envio do número, inclusive a resposta, e só barra o que vem antes dele", async () => {
    const numero = await novoNumero();
    await disparos(numero, 3);
    const resposta = new Date(AGORA.getTime() - 10_000);
    await recordSend(pool, org, numero, resposta, { resposta: true });
    const regra: RegraDaVaga = { ...TETO, intervaloMs: 10_000 };
    expect(await reservarVaga(pool, org, numero, new Date(resposta.getTime() + 9_999), regra)).toBe("intervalo");
    expect(await doDia(numero)).toBe(3);
    expect(await reservarVaga(pool, org, numero, new Date(resposta.getTime() + 10_000), regra)).toBe("reservada");
    // Uma rodada atrasada, com o instante de antes do último envio, não passa.
    expect(await reservarVaga(pool, org, numero, new Date(AGORA.getTime() - 60_000), regra)).toBe("intervalo");
    expect(await doDia(numero)).toBe(4);
  });

  it("o intervalo é do número e da organização: o envio de outro número, ou de outra organização no mesmo número, não segura", async () => {
    const numero = await novoNumero();
    const vizinho = await novoNumero();
    const instante = new Date(AGORA.getTime() + 600_000);
    await recordSend(pool, org, vizinho, instante);
    await recordSend(pool, outraOrg, numero, instante);
    const regra: RegraDaVaga = { ...TETO, intervaloMs: 10_000 };
    expect(await reservarVaga(pool, org, numero, new Date(instante.getTime() + 1), regra)).toBe("reservada");
  });

  it("sem intervalo pedido (balão seguinte, número oficial), não confere o intervalo", async () => {
    const numero = await novoNumero();
    await recordSend(pool, org, numero, AGORA);
    expect(await reservarVaga(pool, org, numero, AGORA, TETO)).toBe("reservada");
    expect(await doDia(numero)).toBe(2);
  });

  it("o teto conta só o dia, o número e a organização da vaga", async () => {
    const numero = await novoNumero();
    const vizinho = await novoNumero();
    // Ontem: não conta.
    await disparos(numero, 30, org, new Date("2026-11-17T12:00:00Z"));
    // Outro número da mesma organização: não conta.
    await disparos(vizinho, 30);
    // O mesmo número com outra organização (linha estranha): não conta.
    await disparos(numero, 30, outraOrg);
    await disparos(numero, 59);
    expect(await reservarVaga(pool, org, numero, AGORA, TETO)).toBe("reservada");
    expect(await reservarVaga(pool, org, numero, new Date(AGORA.getTime() + 1), TETO)).toBe("teto_cheio");
  });

  it("o 1º balão só sai se couberem todos, e grava só a vaga dele", async () => {
    const numero = await novoNumero();
    await disparos(numero, 58);
    expect(await reservarVaga(pool, org, numero, AGORA, { ...TETO, vagas: 3 })).toBe("teto_cheio");
    expect(await doDia(numero)).toBe(58);
    expect(await reservarVaga(pool, org, numero, AGORA, { ...TETO, vagas: 2 })).toBe("reservada");
    expect(await doDia(numero)).toBe(59);
  });

  it("sem teto (número oficial), grava sempre, sob a mesma trava", async () => {
    const numero = await novoNumero();
    await disparos(numero, 61);
    expect(await reservarVaga(pool, org, numero, AGORA, { ...TETO, limite: null })).toBe("reservada");
    expect(await doDia(numero)).toBe(62);
  });

  it("o erro do banco não grava nada e não deixa a conexão presa na transação", async () => {
    const numero = await novoNumero();
    // Organização inexistente: a FK recusa o INSERT.
    await expect(reservarVaga(pool, randomUUID(), numero, AGORA, TETO)).rejects.toThrow();
    // Todas as conexões do pool seguem fora de transação: doze reservas depois funcionam.
    const resultados = await Promise.all(
      Array.from({ length: 12 }, (_, i) => reservarVaga(pool, org, numero, new Date(AGORA.getTime() + i), TETO)),
    );
    expect(resultados.every((r) => r === "reservada")).toBe(true);
    expect(await doDia(numero)).toBe(12);
  });

  it("a espera pela trava tem limite: com o número preso além dele, a reserva lança e não grava", async () => {
    const numero = await novoNumero();
    const agente = await prenderONumero(numero);
    try {
      const inicio = Date.now();
      await expect(reservarVaga(pool, org, numero, AGORA, { ...TETO, esperaMs: 300 })).rejects.toThrow(/lock/i);
      // Desiste no tempo pedido, e não no padrão.
      expect(Date.now() - inicio).toBeLessThan(5_000);
    } finally {
      await agente.query("rollback").catch(() => undefined);
      agente.release(true);
    }
    expect(await doDia(numero)).toBe(0);
    expect(await reservarVaga(pool, org, numero, AGORA, TETO)).toBe("reservada");
  });

  it("sem espera pedida, a reserva espera o padrão de 15 s pela trava e desiste", async () => {
    // O número vai escrito, e não lido da constante: comparar com a própria constante
    // deixaria passar qualquer valor dela (o arnês da v9 provou, com 1 s no lugar de 15).
    // Os 15 s são o contrato da operação (F5-OPERACAO, seção 3).
    const PADRAO_MS = 15_000;
    expect(ESPERA_PELA_TRAVA_MS).toBe(PADRAO_MS);
    const numero = await novoNumero();
    const agente = await prenderONumero(numero);
    try {
      const inicio = Date.now();
      await expect(reservarVaga(pool, org, numero, AGORA, TETO)).rejects.toThrow(/lock/i);
      const esperou = Date.now() - inicio;
      expect(esperou).toBeGreaterThanOrEqual(PADRAO_MS - 500);
      expect(esperou).toBeLessThan(PADRAO_MS + 8_000);
    } finally {
      await agente.query("rollback").catch(() => undefined);
      agente.release(true);
    }
    expect(await doDia(numero)).toBe(0);
  }, 40_000);

  it("a espera vale só dentro da reserva: a conexão volta ao pool sem o lock_timeout", async () => {
    // Pool de uma conexão só: a consulta seguinte usa a mesma sessão da reserva.
    const unico = new pg.Pool({
      host: "127.0.0.1",
      port: Number(process.env.TEST_DB_PORT ?? 54329),
      user: "postgres",
      password: "postgres",
      database: "postgres",
      max: 1,
    });
    try {
      const antes = (await unico.query<{ lock_timeout: string }>("show lock_timeout")).rows[0]!.lock_timeout;
      const numero = await novoNumero();
      expect(await reservarVaga(unico, org, numero, AGORA, { ...TETO, esperaMs: 300 })).toBe("reservada");
      expect(await reservarVaga(unico, org, numero, AGORA, { ...TETO, limite: 1, esperaMs: 300 })).toBe("teto_cheio");
      const depois = (await unico.query<{ lock_timeout: string }>("show lock_timeout")).rows[0]!.lock_timeout;
      expect(depois).toBe(antes);
    } finally {
      await unico.end();
    }
  });

  it("a vaga reservada segura o intervalo da seguinte: oito reservas juntas com intervalo, só uma passa", async () => {
    for (let volta = 0; volta < 3; volta++) {
      const numero = await novoNumero();
      const regra: RegraDaVaga = { ...TETO, intervaloMs: 1_500 };
      const resultados = await Promise.all(
        Array.from({ length: 8 }, (_, i) => reservarVaga(pool, org, numero, new Date(AGORA.getTime() + i * 10), regra)),
      );
      expect(resultados.filter((r) => r === "reservada")).toHaveLength(1);
      expect(resultados.filter((r) => r === "intervalo")).toHaveLength(7);
      expect(await doDia(numero)).toBe(1);
    }
  });
});

/**
 * F4q do cxj (Q08) · a vaga de uma RESPOSTA. O resgate da fila manda a resposta que ficou presa
 * (o canal segurou a mensagem do turno de resposta) e a reserva como resposta: ela não gasta o teto
 * do dia, como na cadeia do agente, mas conta no intervalo do número e é gravada com
 * `resposta = true`, para não aparecer como disparo na contagem do dia.
 */
describe("F4q do cxj (Q08) · a reserva da vaga de uma resposta", () => {
  async function linhasDoInstante(numero: string, quando: Date) {
    const { rows } = await pool.query<{ resposta: boolean }>(
      `select resposta from pacing_ledger
        where organization_id = $1 and channel_session_id = $2 and sent_at = $3`,
      [org, numero, quando],
    );
    return rows.map((r) => r.resposta);
  }

  it("com o teto batido, a resposta é reservada, gravada como resposta, e o dia continua em 60", async () => {
    const numero = await novoNumero();
    await disparos(numero, 60);

    expect(await reservarVaga(pool, org, numero, AGORA, { ...TETO, resposta: true })).toBe("reservada");

    expect(await linhasDoInstante(numero, AGORA)).toEqual([true]);
    expect(await doDia(numero)).toBe(60);
  });

  it("a resposta conta no intervalo: com um envio há 1 s e intervalo de 30 s, não há vaga, e nada é gravado", async () => {
    const numero = await novoNumero();
    await recordSend(pool, org, numero, new Date(AGORA.getTime() - 1_000));

    expect(
      await reservarVaga(pool, org, numero, AGORA, { ...TETO, limite: null, intervaloMs: 30_000, resposta: true }),
    ).toBe("intervalo");

    expect(await linhasDoInstante(numero, AGORA)).toEqual([]);
  });

  it("a resposta reservada segura o intervalo do disparo seguinte", async () => {
    const numero = await novoNumero();
    await reservarVaga(pool, org, numero, AGORA, { ...TETO, resposta: true });

    expect(
      await reservarVaga(pool, org, numero, new Date(AGORA.getTime() + 1_000), { ...TETO, intervaloMs: 30_000 }),
    ).toBe("intervalo");
  });

  it("controle: sem `resposta`, a vaga com o teto batido é recusada, como antes", async () => {
    const numero = await novoNumero();
    await disparos(numero, 60);

    expect(await reservarVaga(pool, org, numero, AGORA, TETO)).toBe("teto_cheio");
    expect(await linhasDoInstante(numero, AGORA)).toEqual([]);
  });
});
