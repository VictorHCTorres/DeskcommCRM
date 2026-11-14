import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { travaDoChipPorPg } from "@/lib/campanhas/chip-de-prospeccao";

/**
 * O NÚMERO DE PROSPECÇÃO NO BANCO REAL (Linha A, v20) — a leitura por conexão (`travaDoChipPorPg`), que a cadeia do
 * agente e o resgate usam. Os dublês unitários casam SQL por padrão; aqui o Postgres decide: quem faz do número um
 * número de prospecção (base legal, rascunho, rodízio, outra organização) e a conversa com uma pessoa no comando
 * (atendente; silêncio vigente × vencido; conversa encerrada).
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

const ORG = randomUUID();
const OUTRA = randomUUID();
const QUARTA_10H = new Date("2026-11-18T13:00:00Z");

beforeAll(async () => {
  for (const id of [ORG, OUTRA]) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name, timezone) values ($1::uuid, $2, 'Org', 'Org', 'America/Fortaleza')`,
      [id, `numero-prospeccao-${id.slice(0, 8)}`],
    );
  }
});
afterAll(() => pool.end());

async function numero(org = ORG) {
  const id = randomUUID();
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
    [id, org, `np-${id.slice(0, 8)}`],
  );
  await pool.query(
    `insert into channel_knobs (organization_id, channel_session_id, window_start_hour, window_end_hour, prospeccao_dias, timezone)
     values ($1, $2, 8, 18, '{1,2,3,4,5}', 'America/Fortaleza')`,
    [org, id],
  );
  return id;
}
async function campanha(sessao: string, base: string, status: string, org = ORG) {
  const id = randomUUID();
  await pool.query(
    `insert into campaigns (id, organization_id, name, channel_session_id, base_legal, lia_ref, status, audience_filter)
     values ($1, $2, 'C', $3, $4, 'LIA', $5, '{"sem_tags":["sair"]}'::jsonb)`,
    [id, org, sessao, base, status],
  );
  return id;
}
async function contato(tags: string[] = []) {
  const id = randomUUID();
  await pool.query(`insert into contacts (id, organization_id, display_name, tags) values ($1, $2, 'Titular', $3)`, [id, ORG, tags]);
  return id;
}
const trava = (sessao: string, contactId: string, agora = QUARTA_10H) =>
  travaDoChipPorPg(pool, { organizationId: ORG, channelSessionId: sessao, contactId }, agora);

describe("v20 · o número de prospecção no Postgres", () => {
  it("⭐ campanha de prospecção CONCLUÍDA no número: é número de prospecção (o feriado de 20/11 recusa)", async () => {
    const s = await numero();
    await campanha(s, "legitimate_interest", "completed");
    expect((await trava(s, await contato(), new Date("2026-11-20T13:00:00Z")))?.motivo).toBe("feriado_nacional");
  });
  it("⭐ só em RASCUNHO: não é número de prospecção", async () => {
    const s = await numero();
    await campanha(s, "legitimate_interest", "draft");
    expect(await trava(s, await contato(), new Date("2026-11-20T13:00:00Z"))).toBeNull();
  });
  it("⭐ só de CONSENTIMENTO: não é número de prospecção", async () => {
    const s = await numero();
    await campanha(s, "consent", "running");
    expect(await trava(s, await contato(), new Date("2026-11-20T13:00:00Z"))).toBeNull();
  });
  it("⭐ pelo RODÍZIO (`campaign_channel_sessions`): é número de prospecção", async () => {
    const principal = await numero();
    const doRodizio = await numero();
    const k = await campanha(principal, "legitimate_interest", "running");
    await pool.query(
      `insert into campaign_channel_sessions (organization_id, campaign_id, channel_session_id) values ($1, $2, $3)`,
      [ORG, k, doRodizio],
    );
    expect((await trava(doRodizio, await contato(), new Date("2026-11-18T10:59:00Z")))?.motivo).toBe("fora_da_janela_de_prospeccao");
  });
  it("⭐ a campanha de prospecção de OUTRA organização no mesmo id de número não conta", async () => {
    const s = await numero();
    await campanha(s, "legitimate_interest", "running", ORG);
    // A pergunta é feita por outra organização: não acha a campanha (que é da ORG).
    const r = await travaDoChipPorPg(pool, { organizationId: OUTRA, channelSessionId: s, contactId: await contato() }, new Date("2026-11-20T13:00:00Z"));
    expect(r).toBeNull();
  });
  it("⭐ a etiqueta de parada da campanha barra", async () => {
    const s = await numero();
    await campanha(s, "legitimate_interest", "running");
    expect((await trava(s, await contato(["sair"])))?.motivo).toBe("etiqueta_de_parada");
  });
  it("⭐ conversa aberta com silêncio VIGENTE barra; com silêncio VENCIDO, não", async () => {
    const s = await numero();
    await campanha(s, "legitimate_interest", "running");
    const vigente = await contato();
    const vencido = await contato();
    await pool.query(
      `insert into conversations (organization_id, contact_id, channel_session_id, status, bot_silenced_until) values ($1, $2, $3, 'open', $4), ($1, $5, $3, 'open', $6)`,
      [ORG, vigente, s, new Date(+QUARTA_10H + 3_600_000), vencido, new Date(+QUARTA_10H - 3_600_000)],
    );
    expect((await trava(s, vigente))?.motivo).toBe("atendimento_humano");
    expect(await trava(s, vencido)).toBeNull();
  });
  it("controle: quarta 10h, pessoa livre: passa", async () => {
    const s = await numero();
    await campanha(s, "legitimate_interest", "running");
    expect(await trava(s, await contato())).toBeNull();
  });
});
