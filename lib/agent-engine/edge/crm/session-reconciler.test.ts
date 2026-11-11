import { afterEach, describe, expect, it, vi } from "vitest";
import type pg from "pg";
import { createLogger } from "../../obs/logger";

import { deveRetomarSessao, redriveQueued } from "./session-reconciler";

afterEach(() => vi.restoreAllMocks());

/**
 * A regra que decide se o watchdog RELIGA a sessão. Religar FAILED é o que o
 * vigia de saúde recusa (pode ser banimento); SCAN_QR_CODE e STARTING já têm
 * dono. Só STOPPED: credencial no disco, sessão parada depois de restart.
 */
describe("deveRetomarSessao", () => {
  it("retoma só STOPPED", () => {
    expect(deveRetomarSessao("STOPPED")).toBe(true);
    expect(deveRetomarSessao("stopped")).toBe(true);
  });

  it.each(["WORKING", "STARTING", "SCAN_QR_CODE", "FAILED", ""])(
    "não religa %s — ou já está no ar, ou precisa de humano",
    (status) => {
      expect(deveRetomarSessao(status)).toBe(false);
    },
  );
});

describe("redrive pré-go-live", () => {
  it("não envia se a releitura da configuração falha", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "message-test", organization_id: "org-test", body: "Resposta de teste",
        waha_session_name: "session-test", phone_number: "+5511999998888",
        wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: "0" }] })
      .mockRejectedValueOnce(new Error("banco indisponível"));

    expect(await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger())).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("m.organization_id = $2"), ["message-test", "org-test"]);
  });
});

/**
 * O RESGATE ALCANÇA A MENSAGEM QUE A AUTOMAÇÃO DEIXOU NA FILA (#652).
 *
 * O carimbo novo só é honesto se o resgate de `queued` souber dele. O registro
 * da automação conta com este resgate quando diz que o envio ficou adiado
 * (`lib/automation/desfecho-do-envio.ts`): uma linha `'automation'` presa com o
 * canal fora ficaria `queued` para sempre enquanto a Atividade da regra diz que
 * a mensagem ainda vai sair.
 *
 * O banco falso abaixo APLICA o filtro de `sent_via` que está na consulta —
 * devolver a linha de qualquer jeito faria o teste passar nos dois mundos, e é
 * justamente o vocabulário da consulta que está sob teste.
 */
function vocabularioDeSentVia(sql: string): string[] | null {
  const igual = /sent_via\s*=\s*'([a-z_]+)'/i.exec(sql);
  if (igual) return [igual[1]!];
  const conjunto = /sent_via\s+in\s*\(([^)]*)\)/i.exec(sql);
  if (conjunto) return [...conjunto[1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  return null;
}

interface LinhaPresa {
  id: string;
  organization_id: string;
  conversation_id: string;
  body: string;
  sent_via: string;
  waha_session_name: string;
  wa_identity: string | null;
  wa_lid: string | null;
  phone_number: string | null;
  is_group: boolean;
  group_chat_id: string | null;
}

function bancoComFila(fila: LinhaPresa[]) {
  const consultas: string[] = [];
  const query = vi.fn(async (sql: string) => {
    consultas.push(sql);
    if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "0" }] };
    if (/select\s+m\.id/i.test(sql)) {
      const vocabulario = vocabularioDeSentVia(sql);
      if (vocabulario === null) return { rows: [] };
      return { rows: fila.filter((l) => vocabulario.includes(l.sent_via)).map((l) => ({ ...l })) };
    }
    if (/select\s+s\.metadata/i.test(sql)) {
      return { rows: fila.length === 0 ? [] : [{ metadata: {}, phone_number: "+5531999998888", operante: true }] };
    }
    return { rows: [] };
  });
  return { query, consultas };
}

describe("resgate da fila — a mensagem da AUTOMAÇÃO é alcançada (#652)", () => {
  it("⭐ linha `sent_via='automation'` presa em queued é reenviada pelo watchdog", async () => {
    const send = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: { id: "3EB0ABCDEF" } }), { status: 200 }));
    const { query } = bancoComFila([
      {
        id: "m-automacao",
        organization_id: "org-1",
        conversation_id: "conversa-1",
        body: "Olá! Vi que você preencheu o formulário.",
        sent_via: "automation",
        waha_session_name: "default",
        wa_identity: null,
        wa_lid: null,
        phone_number: "+5531999998888",
        is_group: false,
        group_chat_id: null,
      },
    ]);

    const reenviadas = await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999",
      wahaApiKey: "test-key",
      intervalMs: 1,
      redriveMinAgeMs: 0,
      redriveBatchSize: 10,
      redriveSpacingMs: 0,
    }, createLogger());

    expect(
      reenviadas,
      "a mensagem da automação ficou presa em `queued`: o resgate só olha sent_via='ai'",
    ).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("CONTROLE: a linha de dispositivo externo não é reenviada — quem a mandou não foi o CRM", async () => {
    // Sem esta direção, um resgate que ignorasse o filtro passaria — e reenviar
    // uma mensagem do celular é mandar de novo o que a pessoa já escreveu.
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const { query } = bancoComFila([
      {
        id: "m-celular",
        organization_id: "org-1",
        conversation_id: "conversa-1",
        body: "oi, tudo bem?",
        sent_via: "external_device",
        waha_session_name: "default",
        wa_identity: null,
        wa_lid: null,
        phone_number: "+5531999998888",
        is_group: false,
        group_chat_id: null,
      },
    ]);

    expect(
      await redriveQueued({ query } as unknown as pg.Pool, {
        wahaBaseUrl: "http://127.0.0.1:9999",
        wahaApiKey: "test-key",
        intervalMs: 1,
        redriveMinAgeMs: 0,
        redriveBatchSize: 10,
        redriveSpacingMs: 0,
      }, createLogger()),
    ).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});


describe("redrive × organização parada", () => {
  it("org não operante: a mensagem vira failed/org_suspensa e nada sai para o WAHA", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "message-test", organization_id: "org-test", body: "Resposta de teste",
        waha_session_name: "session-test", phone_number: "+5511999998888",
        wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: "0" }] })
      .mockResolvedValueOnce({ rows: [{ metadata: {}, phone_number: "+5511999998888", operante: false }] })
      .mockResolvedValue({ rows: [] });

    expect(await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger())).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query.mock.calls[2]?.[0]).toContain("public.fn_org_operante(m.organization_id)");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("error_code = 'org_suspensa'"), ["message-test", "org-test"]);
  });
});

describe("redrive × canal pausado (#2318)", () => {
  it("canal com metadata.disabled: a mensagem vira failed/channel_disabled e nada sai para o WAHA", async () => {
    const send = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response());
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        id: "message-test", organization_id: "org-test", body: "Resposta de antes da pausa",
        waha_session_name: "session-test", phone_number: "+5511999998888",
        wa_identity: null, wa_lid: null, is_group: false, group_chat_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{ n: "0" }] })
      .mockResolvedValueOnce({ rows: [{ metadata: { disabled: true }, phone_number: "+5511999998888", operante: true }] })
      .mockResolvedValue({ rows: [] });

    expect(await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger())).toBe(0);
    expect(send).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("error_code = 'channel_disabled'"), ["message-test", "org-test"]);
  });
});

/**
 * Spec 31 B1: o reenvio do watchdog também responde pelo número que a pessoa
 * escreveu quando a ficha tem telefone extra. Mesma regra do envio normal, em SQL.
 */
describe("redrive × ficha com telefone extra (Spec 31 B1)", () => {
  it("ficha com extra: o reenvio vai para o chat da última mensagem recebida", async () => {
    const send = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: { id: "3EB0NEW" } }), { status: 200 }));
    const consultas: string[] = [];
    const query = vi.fn(async (sql: string) => {
      consultas.push(sql);
      if (/select\s+m\.id/i.test(sql)) {
        return { rows: [{
          id: "m-1", organization_id: "org-1", conversation_id: "conv-1", contact_id: "ficha-1",
          body: "Olá", waha_session_name: "default", wa_identity: null, wa_lid: null,
          phone_number: "+5527999998888", is_group: false, group_chat_id: null,
        }] };
      }
      if (/from contact_phones/i.test(sql)) return { rows: [{ "?column?": 1 }] };
      if (/direction = 'inbound'/i.test(sql)) {
        return { rows: [{ external_id: "false_5531988887777@c.us_3EB0XYZ" }] };
      }
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "0" }] };
      if (/select\s+s\.metadata/i.test(sql)) {
        return { rows: [{ metadata: {}, phone_number: "+5527999998888", operante: true }] };
      }
      return { rows: [] };
    });

    const reenviadas = await redriveQueued({ query } as unknown as pg.Pool, {
      wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
      intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
    }, createLogger());

    expect(reenviadas).toBe(1);
    const corpo = JSON.parse((send.mock.calls[0]![1] as { body: string }).body) as { chatId: string };
    expect(corpo.chatId).toBe("5531988887777@c.us");
    // A consulta de extras e a das mensagens filtram pela organização da linha.
    expect(consultas.some((s) => /from contact_phones[\s\S]*organization_id = \$1/i.test(s))).toBe(true);
    // Sabotagem: deixar `chatIdOf` sem o `ultimoRecebido` manda o reenvio para o
    // principal (5527999998888@c.us) e deixa este teste vermelho.
  });
});

/**
 * F4i do cxj (11/11/2026), A1: a mensagem de campanha de PROSPECÇÃO que ficou na fila física (o canal caiu, ou o veto
 * não conseguiu ser gravado) não sai pelo resgate. O resgate manda direto ao WAHA, sem conferir a pessoa (resposta,
 * atendimento humano, recusa, lista de exclusão, campanha cancelada); quem manda a prospecção é a rodada, que confere
 * tudo de novo. A linha vira `failed/campanha_sem_reenvio`, e a campanha de consentimento segue como antes.
 */
describe("redrive × campanha de prospecção (F4i)", () => {
  const CFG = {
    wahaBaseUrl: "http://127.0.0.1:9999", wahaApiKey: "test-key",
    intervalMs: 1, redriveMinAgeMs: 0, redriveBatchSize: 10, redriveSpacingMs: 0,
  };
  function cenario(metadata: unknown, campanha: (sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>) {
    const send = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: { id: "3EB0NEW" } }), { status: 200 }));
    const consultas: Array<{ sql: string; params: unknown[] }> = [];
    const query = vi.fn(async (sql: string, params: unknown[] = []) => {
      consultas.push({ sql, params });
      if (/select\s+m\.id/i.test(sql)) {
        return { rows: [{
          id: "m-1", organization_id: "org-1", conversation_id: "conv-1", contact_id: "ficha-1", body: "Olá",
          waha_session_name: "default", wa_identity: null, wa_lid: null, phone_number: "+5588999990000",
          is_group: false, group_chat_id: null,
          // Como o banco: a coluna só volta se a consulta a pedir.
          ...(/\bm\.metadata\b/.test(sql) ? { metadata } : {}),
        }] };
      }
      if (/count\(\*\)/i.test(sql)) return { rows: [{ n: "0" }] };
      if (/select\s+s\.metadata/i.test(sql)) return { rows: [{ metadata: {}, phone_number: "+5588999990000", operante: true }] };
      if (/from campaigns/i.test(sql)) return campanha(sql, params);
      return { rows: [] };
    });
    const rodar = () => redriveQueued({ query } as unknown as pg.Pool, CFG, createLogger());
    const bloqueio = () => consultas.find((c) => c.sql.includes("error_code = 'campanha_sem_reenvio'"));
    const leuCampanha = () => consultas.filter((c) => /from campaigns/i.test(c.sql));
    return { send, rodar, bloqueio, leuCampanha };
  }
  const daCampanha = { source: "campaign", campaign_id: "camp-1", campaign_recipient_id: "r-1" };

  it("⭐ mensagem presa de campanha de prospecção: não sai pelo resgate, e vira failed/campanha_sem_reenvio", async () => {
    const c = cenario(daCampanha, async () => ({ rows: [{ base_legal: "legitimate_interest" }] }));
    expect(await c.rodar()).toBe(0);
    expect(c.send).not.toHaveBeenCalled();
    expect(c.bloqueio()?.params).toEqual(["m-1", "org-1"]);
    expect(c.leuCampanha()[0]?.params).toEqual(["org-1", "camp-1"]);
  });

  it("⭐ a campanha não se acha (apagada, ou o id não casa): também não sai (falha fechada)", async () => {
    const c = cenario(daCampanha, async () => ({ rows: [] }));
    expect(await c.rodar()).toBe(0);
    expect(c.send).not.toHaveBeenCalled();
    expect(c.bloqueio()).toBeDefined();
  });

  it("⭐ a campanha voltou sem a base legal (só o status, como no dublê do cxj): não sai", async () => {
    const c = cenario(daCampanha, async () => ({ rows: [{ status: "cancelled" }] }));
    expect(await c.rodar()).toBe(0);
    expect(c.send).not.toHaveBeenCalled();
    expect(c.bloqueio()).toBeDefined();
  });

  it("⭐ de campanha, mas sem o id da campanha: não sai", async () => {
    const c = cenario({ source: "campaign" }, async () => ({ rows: [] }));
    expect(await c.rodar()).toBe(0);
    expect(c.send).not.toHaveBeenCalled();
    expect(c.bloqueio()).toBeDefined();
  });

  it("⭐ sem conseguir ler a campanha: não sai, e a linha fica na fila para o próximo tique", async () => {
    const c = cenario(daCampanha, async () => {
      throw new Error("leitura de campaigns falhou");
    });
    expect(await c.rodar()).toBe(0);
    expect(c.send).not.toHaveBeenCalled();
    expect(c.bloqueio()).toBeUndefined();
  });

  it("controle: campanha de consentimento segue como antes, e sai pelo resgate", async () => {
    const c = cenario(daCampanha, async () => ({ rows: [{ base_legal: "consent" }] }));
    expect(await c.rodar()).toBe(1);
    expect(c.send).toHaveBeenCalledTimes(1);
    expect(c.bloqueio()).toBeUndefined();
  });

  it("controle: a mensagem que não é de campanha não lê campanha nenhuma, e sai como antes", async () => {
    const c = cenario({ source: "agent" }, async () => ({ rows: [{ base_legal: "legitimate_interest" }] }));
    expect(await c.rodar()).toBe(1);
    expect(c.send).toHaveBeenCalledTimes(1);
    expect(c.leuCampanha()).toEqual([]);
  });

  // O arnês de mutações da v4 (11/11/2026, 18h23) achou estas três propriedades sem teste. Só testes: a produção não mudou.

  it("⭐ o bloqueio tira a linha da fila física (`failed`), e só se ela ainda estiver `queued`: não reescreve o que outro caminho mudou", async () => {
    const c = cenario(daCampanha, async () => ({ rows: [{ base_legal: "legitimate_interest" }] }));
    await c.rodar();
    const sql = c.bloqueio()!.sql.replace(/\s+/g, " ");
    expect(sql).toMatch(/set status = 'failed', error_code = 'campanha_sem_reenvio'/);
    expect(sql).toMatch(/where id = \$1 and organization_id = \$2 and status = 'queued'/);
  });

  it("⭐ a campanha é procurada na organização da mensagem: a de consentimento de OUTRA organização, com o mesmo id, não libera o resgate", async () => {
    const campanhas = [{ organization_id: "org-2", id: "camp-1", base_legal: "consent" }];
    const c = cenario(daCampanha, async (sql, params) => {
      const daOrganizacao = /k\.organization_id\s*=\s*\$1/i.test(sql);
      return { rows: campanhas.filter((k) => (!daOrganizacao || k.organization_id === params[0]) && k.id === params[1]) };
    });
    expect(await c.rodar()).toBe(0);
    expect(c.send).not.toHaveBeenCalled();
    expect(c.bloqueio()).toBeDefined();
  });
});
