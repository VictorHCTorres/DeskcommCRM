import type pg from "pg";
import { describe, expect, it, vi } from "vitest";

import { runBeforeSend } from "@/lib/agent-engine/guardrails/before-send";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { OPCAO_EXCECAO_FUNIL_A } from "@/lib/escalacao/excecao-funil-a";

/**
 * A exceção da Linha A pela cadeia REAL de envio (1.110.2).
 *
 * O que se prova aqui, e que o teste puro não prova: a cadeia lê a opção e o
 * negócio, o gate usa o que foi lido, e — o mais importante — com a opção
 * DESLIGADA ou fora da Linha A o veredito é o de antes, corpo por corpo.
 */

const AGORA = new Date("2026-07-28T13:00:00Z"); // 10h BRT, terça
const OFERTA = "São R$ 697, com a taxa do INPI à parte, se houver. Posso pedir o Pix?";
const OUTRO_VALOR = "Consigo fazer por R$ 600. Posso pedir o Pix?";
const PARCELADO = "São R$ 697, e dá para parcelar. Posso pedir o Pix?";
const SEM_PRECO = "O INPI negou o pedido; cabe recurso até 23/11, pela publicação.";
const COM_GARANTIA = "Fique tranquilo, o resultado é garantido.";

type Cenario = {
  /** A linha da opção: `null` = sem linha (o estado de todo deploy). */
  opcao: boolean | null;
  etiquetas?: string[];
  negocios?: Array<{ funil_nome: string; funil_slug: string; campos: Record<string, unknown> }>;
  /** `false` = a organização não ligou a restrição comercial. */
  restricao?: boolean;
};

const LINHA_A: Required<Pick<Cenario, "etiquetas" | "negocios">> = {
  etiquetas: ["funil-a"],
  negocios: [{ funil_nome: "Prospecção", funil_slug: "prospeccao", campos: { preco: "R$ 697", codigo: "xjvx5klebf" } }],
};

function cadeia(body: string, c: Cenario) {
  const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
  const leuContato = vi.fn();
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
    query: vi.fn(async (sql: string, values: unknown[]) => {
      if (sql.includes("org_guardrail_layers")) {
        if (values?.[1] === OPCAO_EXCECAO_FUNIL_A) return { rows: c.opcao === null ? [] : [{ enabled: c.opcao }] };
        return { rows: [{ enabled: c.restricao ?? true }] };
      }
      if (sql.includes("from contacts c") && sql.includes("crm_leads l")) {
        leuContato();
        return { rows: [{ etiquetas: c.etiquetas ?? [], negocios: c.negocios ?? [] }] };
      }
      return { rows: [{ id: "trace-1" }] };
    }),
  } as unknown as pg.Pool;
  const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const send = vi.fn(async () => ({ kind: "sent" as const, idempotencyKey: "k", messageId: "m" }));
  return {
    send,
    leuContato,
    run: runBeforeSend({
      pool,
      log,
      tenantId: "00000000-0000-4000-8000-000000000001",
      leadId: "00000000-0000-4000-8000-000000000002",
      jobId: "00000000-0000-4000-8000-000000000003",
      channelSessionId: "00000000-0000-4000-8000-000000000004",
      body,
      optedOutThisTurn: false,
      crmDailyLimit: null,
      now: AGORA,
      rng: () => 0,
      sleep: async () => {},
      // como o turno do agente arma: a escolha da organização, lida uma vez
      enforceCommercialRestriction: c.restricao ?? true,
      send,
    }),
  };
}

describe("Linha A com a opção LIGADA", () => {
  const ligada: Cenario = { opcao: true, ...LINHA_A };

  it("preço exato do negócio: a resposta SAI", async () => {
    const { run, send } = cadeia(OFERTA, ligada);
    const r = await run;
    expect(r.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    expect(r.trace).toContainEqual({ gate: "commercial_restriction", verdict: "pass" });
  });

  it("outro valor: barrada, com o mesmo código da trava (a conversa vai à equipe)", async () => {
    const { run, send } = cadeia(OUTRO_VALOR, ligada);
    const r = await run;
    expect(r.status).toBe("vetoed");
    expect(send).not.toHaveBeenCalled();
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.gate).toBe("commercial_restriction");
    expect(r.code).toBe("commercial_requires_human");
    expect(r.trace).toContainEqual({
      gate: "commercial_restriction",
      verdict: "veto",
      code: "commercial_requires_human",
      detail: { restricted_kind: "commercial", excecao_funil_a: "valor_diferente_do_preco" },
    });
  });

  it("preço certo com parcelamento: barrada", async () => {
    const { run, send } = cadeia(PARCELADO, ligada);
    const r = await run;
    expect(r.status).toBe("vetoed");
    expect(send).not.toHaveBeenCalled();
    if (r.status === "vetoed") expect(r.code).toBe("commercial_requires_human");
  });

  it("promessa sem palavra de preço: barrada também (a conferência vale para a resposta inteira)", async () => {
    const { run, send } = cadeia(COM_GARANTIA, ligada);
    expect((await run).status).toBe("vetoed");
    expect(send).not.toHaveBeenCalled();
  });

  it("resposta sem preço: sai", async () => {
    expect((await cadeia(SEM_PRECO, ligada).run).status).toBe("sent");
  });
});

describe("opção DESLIGADA: nada muda, nem para o contato da Linha A", () => {
  it.each<[string, boolean | null]>([["sem linha", null], ["enabled=false", false]])(
    "%s: o preço exato segue barrado e o negócio nem é lido",
    async (_nome, opcao) => {
      const { run, send, leuContato } = cadeia(OFERTA, { opcao, ...LINHA_A });
      const r = await run;
      expect(r.status).toBe("vetoed");
      expect(send).not.toHaveBeenCalled();
      expect(leuContato).not.toHaveBeenCalled();
      if (r.status !== "vetoed") throw new Error("inalcançável");
      expect(r.code).toBe("commercial_requires_human");
      // o trace é o de antes: sem o campo da exceção
      expect(r.trace).toContainEqual({
        gate: "commercial_restriction",
        verdict: "veto",
        code: "commercial_requires_human",
        detail: { restricted_kind: "commercial" },
      });
    },
  );

  it("sem linha: o que saía continua saindo (inclusive 'garantido', que a trava de sempre não olha)", async () => {
    expect((await cadeia(SEM_PRECO, { opcao: null, ...LINHA_A }).run).status).toBe("sent");
    expect((await cadeia(COM_GARANTIA, { opcao: null, ...LINHA_A }).run).status).toBe("sent");
  });
});

describe("fora da Linha A, com a opção ligada: comportamento idêntico ao atual", () => {
  const FORA: Array<[string, Cenario]> = [
    ["contato sem a etiqueta funil-a", { opcao: true, etiquetas: ["cliente"], negocios: LINHA_A.negocios }],
    ["sem negócio aberto na Prospecção", { opcao: true, etiquetas: ["funil-a"], negocios: [] }],
    ["negócio aberto só em outro funil", { opcao: true, etiquetas: ["funil-a"], negocios: [{ funil_nome: "Vendas", funil_slug: "vendas", campos: { preco: "R$ 697" } }] }],
    ["dois negócios abertos na Prospecção", { opcao: true, etiquetas: ["funil-a"], negocios: [...LINHA_A.negocios, ...LINHA_A.negocios] }],
    ["preco vazio", { opcao: true, etiquetas: ["funil-a"], negocios: [{ funil_nome: "Prospecção", funil_slug: "prospeccao", campos: { preco: "", codigo: "x" } }] }],
  ];

  it.each(FORA)("%s: o preço segue barrado", async (_nome, cenario) => {
    const { run, send } = cadeia(OFERTA, cenario);
    const r = await run;
    expect(r.status).toBe("vetoed");
    expect(send).not.toHaveBeenCalled();
    if (r.status !== "vetoed") throw new Error("inalcançável");
    expect(r.trace).toContainEqual({
      gate: "commercial_restriction",
      verdict: "veto",
      code: "commercial_requires_human",
      detail: { restricted_kind: "commercial" },
    });
  });

  it.each(FORA)("%s: o que não é preço segue saindo", async (_nome, cenario) => {
    expect((await cadeia(SEM_PRECO, cenario).run).status).toBe("sent");
    expect((await cadeia(COM_GARANTIA, cenario).run).status).toBe("sent");
  });
});

describe("organização sem a restrição comercial: a exceção nem é lida", () => {
  it("opção ligada e restrição desligada: tudo sai como sempre, sem conferência da Linha A", async () => {
    for (const body of [OFERTA, OUTRO_VALOR, PARCELADO, COM_GARANTIA]) {
      const { run, leuContato } = cadeia(body, { opcao: true, restricao: false, ...LINHA_A });
      expect((await run).status).toBe("sent");
      expect(leuContato).not.toHaveBeenCalled();
    }
  });
});
