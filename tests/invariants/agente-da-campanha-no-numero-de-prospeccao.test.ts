import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { agenteDaCampanhaDaConversa } from "@/lib/agent-engine/agent/agente-da-campanha";

/**
 * O AGENTE DECLARADO PELA CAMPANHA NO NÚMERO DE PROSPECÇÃO (Linha A, v20 — achado 2 do revisor independente 1).
 *
 * O degrau 0 da escolha do agente (`resolve-turn-agent.ts`) põe para responder o agente que a campanha declarou
 * (`campaigns.agent_id`), acima do roteador e do agente do número, e `loadPublishedAgentConfigById` o carrega sem
 * olhar o número. Uma campanha qualquer (até concluída) com um agente de outro número fazia esse agente responder no
 * chip de prospecção, com as bolhas, a voz e o aviso fora do horário dele. Agora, no número de prospecção, só o
 * agente PUBLICADO NESTE NÚMERO vale pelo degrau 0; fora dele, nada muda.
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
const CHIP = randomUUID();
const OUTRO = randomUUID();
const AGENTE_DO_CHIP = randomUUID();
const AGENTE_DE_OUTRO = randomUUID();

async function agente(id: string, sessao: string) {
  const versao = randomUUID();
  await pool.query(`insert into ai_agents (id, organization_id, name, system_prompt) values ($1, $2, $3, 'system')`, [id, ORG, `ag-${id.slice(0, 4)}`]);
  await pool.query(
    `insert into ai_agent_versions (id, organization_id, agent_id, version_number, system_prompt, provider, model, channel_session_id, status)
     values ($1, $2, $3, 1, 'system', 'anthropic', 'claude-sonnet-4-6', $4, 'published')`,
    [versao, ORG, id, sessao],
  );
  await pool.query(`update ai_agents set published_version_id = $1 where id = $2`, [versao, id]);
}

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1::uuid, $2, 'Org de Prova', 'Org de Prova')`,
    [ORG, `agente-campanha-${ORG.slice(0, 8)}`],
  );
  for (const [id, nome] of [[CHIP, "chip-5286"], [OUTRO, "outro-numero"]] as const) {
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, $2, $3, 'WORKING', '\\x00'::bytea)`,
      [id, ORG, `${nome}-${ORG.slice(0, 6)}`],
    );
  }
  await agente(AGENTE_DO_CHIP, CHIP);
  await agente(AGENTE_DE_OUTRO, OUTRO);
});
afterAll(() => pool.end());

/** Uma conversa no `sessao`, nascida de uma campanha que declara `agenteDaCampanha`. */
async function conversaDeCampanha(sessao: string, base: "legitimate_interest" | "consent", agenteDaCampanha: string, status = "completed") {
  const contato = randomUUID();
  const conversa = randomUUID();
  const campanha = randomUUID();
  await pool.query("insert into contacts (id, organization_id, display_name) values ($1, $2, 'Titular')", [contato, ORG]);
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status) values ($1, $2, $3, $4, 'open')`,
    [conversa, ORG, contato, sessao],
  );
  await pool.query(
    `insert into campaigns (id, organization_id, name, channel_session_id, base_legal, lia_ref, status, agent_id)
     values ($1, $2, 'Campanha', $3, $4, 'LIA-fictícia', $5, $6)`,
    [campanha, ORG, sessao, base, status, agenteDaCampanha],
  );
  await pool.query(
    `insert into campaign_recipients (organization_id, campaign_id, contact_id, status, eligibility_status, conversation_id, sent_at)
     values ($1, $2, $3, 'sent', 'eligible', $4, now())`,
    [ORG, campanha, contato, conversa],
  );
  return conversa;
}

describe("v20 · o número de prospecção só responde com o agente do número", () => {
  it("⭐ campanha de prospecção no chip declarando um agente de OUTRO número: o degrau 0 não o põe para responder", async () => {
    const conversa = await conversaDeCampanha(CHIP, "legitimate_interest", AGENTE_DE_OUTRO);
    expect(await agenteDaCampanhaDaConversa(pool, ORG, conversa)).toBeNull();
  });

  it("⭐ o chip é de prospecção (por outra campanha) e a conversa nasceu de uma de consentimento com agente alheio: também não", async () => {
    await conversaDeCampanha(CHIP, "legitimate_interest", AGENTE_DO_CHIP, "running");
    const conversa = await conversaDeCampanha(CHIP, "consent", AGENTE_DE_OUTRO);
    expect(await agenteDaCampanhaDaConversa(pool, ORG, conversa)).toBeNull();
  });

  it("controle: a campanha de prospecção que declara o agente DO CHIP segue valendo", async () => {
    const conversa = await conversaDeCampanha(CHIP, "legitimate_interest", AGENTE_DO_CHIP);
    expect(await agenteDaCampanhaDaConversa(pool, ORG, conversa)).toBe(AGENTE_DO_CHIP);
  });

  it("controle: fora do número de prospecção, o agente declarado pela campanha responde, como no upstream", async () => {
    const conversa = await conversaDeCampanha(OUTRO, "consent", AGENTE_DO_CHIP);
    expect(await agenteDaCampanhaDaConversa(pool, ORG, conversa)).toBe(AGENTE_DO_CHIP);
  });
});
