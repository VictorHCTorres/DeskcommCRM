import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { recordSend, undoSend } from "@/lib/agent-engine/pacing/store";

/**
 * A VAGA DEVOLVIDA (revisão F4m do cxj, 11/11/2026, M01).
 *
 * A campanha registra a vaga no `pacing_ledger` ANTES de o balão sair: nenhuma
 * mensagem sai sem estar no teto do número, e o teto não depende de uma pausa
 * gravada depois. Quando o balão certamente não saiu (o handler vetou, a
 * organização parou, o canal segurou sem chamar o provedor), a vaga volta com
 * `undoSend`. O que este arquivo prova, contra o schema real, é que a devolução
 * tira UMA linha de disparo daquele instante e daquele número — nunca a
 * resposta, nunca a de outro número — e nada quando não há linha.
 */

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 2,
});

const org = randomUUID();
const outraOrg = randomUUID();
const sessao = randomUUID();
const outra = randomUUID();
const AGORA = new Date("2026-07-28T13:00:00Z");

beforeAll(async () => {
  for (const id of [org, outraOrg]) {
    await pool.query(
      `insert into organizations(id,slug,legal_name,display_name,timezone)
       values($1::uuid,$1::text,'Teste Vaga','Teste Vaga','America/Sao_Paulo')`,
      [id],
    );
  }
  for (const [id, nome] of [
    [sessao, "vaga-test-1"],
    [outra, "vaga-test-2"],
  ] as const) {
    await pool.query(
      `insert into channel_sessions(id,organization_id,provider,waha_session_name,status,webhook_secret_encrypted)
       values($1,$2,'waha',$3,'WORKING','\\x00'::bytea)`,
      [id, org, nome],
    );
  }
});
afterAll(() => pool.end());

async function linhas(numero: string) {
  const { rows } = await pool.query<{ sent_at: Date; resposta: boolean }>(
    `select sent_at, resposta from pacing_ledger
      where organization_id = $1 and channel_session_id = $2
      order by sent_at, resposta`,
    [org, numero],
  );
  return rows.map((r) => ({ quando: new Date(r.sent_at).getTime(), resposta: r.resposta }));
}

describe("devolver a vaga no schema real", () => {
  it("tira uma só linha de disparo do instante e do número; a resposta do mesmo instante e o outro número ficam", async () => {
    await recordSend(pool, org, sessao, AGORA);
    await recordSend(pool, org, sessao, AGORA);
    await recordSend(pool, org, sessao, AGORA, { resposta: true });
    await recordSend(pool, org, outra, AGORA);

    await undoSend(pool, org, sessao, AGORA);

    expect(await linhas(sessao)).toEqual([
      { quando: AGORA.getTime(), resposta: false },
      { quando: AGORA.getTime(), resposta: true },
    ]);
    expect(await linhas(outra)).toEqual([{ quando: AGORA.getTime(), resposta: false }]);
  });

  it("sem linha de disparo daquele instante, não tira nada", async () => {
    const antes = await linhas(sessao);
    await undoSend(pool, org, sessao, new Date(AGORA.getTime() + 1));
    expect(await linhas(sessao)).toEqual(antes);
  });

  it("a resposta sozinha no instante não é devolvida: ela não gastou o teto", async () => {
    const instante = new Date(AGORA.getTime() + 60_000);
    await recordSend(pool, org, outra, instante, { resposta: true });
    await undoSend(pool, org, outra, instante);
    expect(await linhas(outra)).toEqual([
      { quando: AGORA.getTime(), resposta: false },
      { quando: instante.getTime(), resposta: true },
    ]);
  });

  it("o número pedido sem linha no instante: a linha de OUTRO número, no mesmo instante, fica", async () => {
    const instante = new Date(AGORA.getTime() + 120_000);
    await recordSend(pool, org, outra, instante);
    await undoSend(pool, org, sessao, instante);
    expect(await linhas(outra)).toContainEqual({ quando: instante.getTime(), resposta: false });
  });

  it("F4q do cxj (Q08) · com `resposta: true`, devolve a linha de RESPOSTA do instante, e o disparo do mesmo instante fica", async () => {
    const instante = new Date(AGORA.getTime() + 240_000);
    await recordSend(pool, org, outra, instante);
    await recordSend(pool, org, outra, instante, { resposta: true });

    await undoSend(pool, org, outra, instante, { resposta: true });

    expect((await linhas(outra)).filter((l) => l.quando === instante.getTime())).toEqual([
      { quando: instante.getTime(), resposta: false },
    ]);
  });

  it("F4q do cxj (Q08) · com `resposta: true` e só o disparo no instante, não tira nada", async () => {
    const instante = new Date(AGORA.getTime() + 300_000);
    await recordSend(pool, org, outra, instante);

    await undoSend(pool, org, outra, instante, { resposta: true });

    expect((await linhas(outra)).filter((l) => l.quando === instante.getTime())).toEqual([
      { quando: instante.getTime(), resposta: false },
    ]);
  });

  it("a linha do mesmo número e instante gravada com OUTRA organização não é devolvida", async () => {
    const instante = new Date(AGORA.getTime() + 180_000);
    await recordSend(pool, outraOrg, sessao, instante);
    await undoSend(pool, org, sessao, instante);
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pacing_ledger
        where organization_id = $1 and channel_session_id = $2 and sent_at = $3`,
      [outraOrg, sessao, instante],
    );
    expect(rows[0]!.n).toBe(1);
  });
});
