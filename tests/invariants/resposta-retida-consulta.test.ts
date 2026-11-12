/**
 * A PERGUNTA DA ORDEM, NO POSTGRES (F4w do cxj, 12/11/2026, W02; versão 18).
 *
 * `haRespostaRetidaAntes` responde, no banco: “há, nesta conversa, uma resposta do agente retida e mais antiga do que
 * esta mensagem?”. É a pergunta que o handler faz antes de mandar um texto do agente, e a mesma condição que o resgate
 * põe na seleção e na releitura dele (`respostaRetidaAntesSql`).
 *
 * Retida é a mensagem de saída, de texto, ainda na fila (`queued`), com um dos dois motivos da cadeia do agente (a
 * idade, ou a ordem), com a marca de resposta, e criada há menos do que a validade. Mais antiga é pela hora de criação
 * e, na mesma hora, pelo id.
 *
 * A regra de ponta a ponta (a cadeia, o handler e o resgate) está em `tests/invariants/resposta-retida-na-ordem.test.ts`.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  VALIDADE_DA_RESPOSTA_RETIDA_MS,
  haRespostaRetidaAntes,
} from "@/lib/agent-engine/pacing/resposta-retida";

if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const pool = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 4,
});
afterAll(() => pool.end());
// O resgate dos outros arquivos é global: nada daqui fica na fila.
afterEach(() => pool.query("update messages set status='failed' where status='queued'"));

async function fixture() {
  const org = randomUUID(), session = randomUUID();
  // Duas conversas, cada uma com o seu contato (o número aceita uma conversa por contato).
  const contact = randomUUID(), conversa = randomUUID(), outroContato = randomUUID(), outra = randomUUID();
  await pool.query(
    "insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,'Teste da ordem','Teste da ordem','America/Sao_Paulo')",
    [org],
  );
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,status,webhook_secret_encrypted,daily_message_limit) values($1::uuid,$2,$1::text,'WORKING','\\x00'::bytea,60)",
    [session, org],
  );
  const pares: Array<[string, string, string]> = [
    [contact, conversa, "1234"],
    [outroContato, outra, "5678"],
  ];
  for (const [contato, id, final] of pares) {
    await pool.query("insert into contacts(id,organization_id,name,phone_number) values($1,$2,'Contato fictício',$3)", [
      contato,
      org,
      "+" + "55" + "88" + "9".repeat(5) + final,
    ]);
    await pool.query("insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')", [
      id,
      org,
      contato,
      session,
    ]);
  }
  return { org, contact, outroContato, session, conversa, outra };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A hora de criação das mensagens do teste: há um minuto, ou `segundos` antes ou depois disso. */
const BASE = Date.now() - 60_000;
const quando = (segundos = 0) => new Date(BASE + segundos * 1000);

interface Linha {
  id?: string;
  conversa?: string;
  criada?: Date;
  direction?: "outbound" | "inbound";
  type?: string;
  status?: string;
  metadata?: Record<string, unknown>;
}
const RETIDA = { queued_reason: "saida_do_agente_vencida", queued_resposta: true };
/** Uma mensagem da conversa; por padrão, um texto de saída da IA na fila, sem motivo, criado há um minuto. */
async function mensagem(f: Fixture, linha: Linha = {}) {
  const id = linha.id ?? randomUUID();
  const direction = linha.direction ?? "outbound";
  await pool.query(
    `insert into messages(id,organization_id,conversation_id,contact_id,channel_session_id,direction,type,body,status,sent_via,created_at,metadata)
     values($1,$2,$3,$4,$5,$6,$7,'Fictícia',$8,$9,$10,$11::jsonb)`,
    [
      id,
      f.org,
      linha.conversa ?? f.conversa,
      linha.conversa === f.outra ? f.outroContato : f.contact,
      f.session,
      direction,
      linha.type ?? "text",
      linha.status ?? "queued",
      direction === "outbound" ? "ai" : "external_device",
      linha.criada ?? quando(),
      JSON.stringify(linha.metadata ?? {}),
    ],
  );
  return id;
}
/** A pergunta, para a mensagem `id` da conversa do teste. */
const pergunta = (f: Fixture, id: string, conversa = f.conversa) =>
  haRespostaRetidaAntes(pool, f.org, { conversationId: conversa, messageId: id });

describe("haRespostaRetidaAntes — a pergunta da ordem, no banco (versão 18)", () => {
  it("⭐ a resposta retida por idade, mais antiga, na mesma conversa, segura a mensagem", async () => {
    const f = await fixture();
    await mensagem(f, { criada: quando(-10), metadata: RETIDA });
    expect(await pergunta(f, await mensagem(f))).toBe(true);
  });

  it("⭐ a que esperou por ordem também segura a seguinte", async () => {
    const f = await fixture();
    await mensagem(f, { criada: quando(-10), metadata: { queued_reason: "atras_de_resposta_retida", queued_resposta: true } });
    expect(await pergunta(f, await mensagem(f))).toBe(true);
  });

  it("controle: sem nada antes, e com uma resposta comum já enviada antes, a mensagem não espera", async () => {
    const f = await fixture();
    expect(await pergunta(f, await mensagem(f))).toBe(false);
    await mensagem(f, { criada: quando(-10), status: "sent" });
    expect(await pergunta(f, await mensagem(f, { criada: quando(1) }))).toBe(false);
  });

  it.each<[string, (f: Fixture) => Linha]>([
    ["a mais nova do que a mensagem", () => ({ criada: quando(10), metadata: RETIDA })],
    ["a de outra conversa", (f) => ({ conversa: f.outra, criada: quando(-10), metadata: RETIDA })],
    ["a que já saiu", () => ({ criada: quando(-10), status: "sent", metadata: RETIDA })],
    ["a que falhou", () => ({ criada: quando(-10), status: "failed", metadata: RETIDA })],
    ["a que não é texto", () => ({ criada: quando(-10), type: "image", metadata: RETIDA })],
    ["a retida por idade sem a marca de resposta", () => ({ criada: quando(-10), metadata: { queued_reason: "saida_do_agente_vencida" } })],
    ["a que tem a marca de resposta falsa", () => ({ criada: quando(-10), metadata: { ...RETIDA, queued_resposta: false } })],
    [
      "a presa por outro motivo (o canal fora do ar), mesmo com a marca",
      () => ({ criada: quando(-10), metadata: { queued_reason: "channel_session_not_working", queued_resposta: true } }),
    ],
    ["a que está na fila sem motivo (o envio em curso)", () => ({ criada: quando(-10), metadata: { queued_resposta: true } })],
    ["a recebida", () => ({ criada: quando(-10), direction: "inbound", metadata: RETIDA })],
  ])("não segura: %s", async (_nome, linha) => {
    const f = await fixture();
    await mensagem(f, linha(f));
    expect(await pergunta(f, await mensagem(f))).toBe(false);
  });

  it("a mensagem retida não segura a si mesma", async () => {
    const f = await fixture();
    expect(await pergunta(f, await mensagem(f, { metadata: RETIDA }))).toBe(false);
  });

  it("na mesma hora de criação, desempata o id: a de id menor segura a de id maior, e não o contrário", async () => {
    const f = await fixture();
    const menor = await mensagem(f, { id: "00000000-0000-4000-8000-000000000001", metadata: RETIDA });
    const maior = await mensagem(f, { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", metadata: RETIDA });
    expect(await pergunta(f, maior)).toBe(true);
    expect(await pergunta(f, menor)).toBe(false);
  });

  it("⭐ a validade: a retida segura as seguintes por 10 minutos, e depois a conversa volta a responder", async () => {
    expect(VALIDADE_DA_RESPOSTA_RETIDA_MS).toBe(600_000);
    const f = await fixture();
    const retida = await mensagem(f, { criada: new Date(Date.now() - VALIDADE_DA_RESPOSTA_RETIDA_MS + 30_000), metadata: RETIDA });
    const seguinte = await mensagem(f);
    // Aos 9 min 30 s, ainda segura.
    expect(await pergunta(f, seguinte)).toBe(true);
    // Aos 10 min 30 s, não segura mais.
    await pool.query("update messages set created_at = created_at - interval '60 seconds' where id=$1", [retida]);
    expect(await pergunta(f, seguinte)).toBe(false);
  });

  it("a mensagem que não se acha (outra conversa, outra organização, ou id que não existe) lança: sem a linha, não há ordem a conferir", async () => {
    const f = await fixture();
    const id = await mensagem(f);
    await expect(pergunta(f, randomUUID())).rejects.toThrow("mensagem_do_envio_nao_encontrada");
    await expect(pergunta(f, id, f.outra)).rejects.toThrow("mensagem_do_envio_nao_encontrada");
    await expect(
      haRespostaRetidaAntes(pool, randomUUID(), { conversationId: f.conversa, messageId: id }),
    ).rejects.toThrow("mensagem_do_envio_nao_encontrada");
  });
});
