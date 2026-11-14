import { describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";

import { corpoDoPixPedido, ganhouPixPedido, OPCAO_PIX_PEDIDO_NA_CENTRAL, TITULO_DO_PIX_PEDIDO } from "./pix-pedido-na-central";
import { pixPedidoNaCentralHandler, tratarPixPedido } from "./pix-pedido-na-central.handler";

const ORG = "00000000-0000-4000-8000-000000000001";
const CONTATO = "00000000-0000-4000-8000-000000000002";
const NEGOCIO = "00000000-0000-4000-8000-000000000003";

const evento = (added: unknown): EventRow => ({
  id: "ev-1", organization_id: ORG, event_type: "contact.tag_added", entity_kind: "contact", entity_id: CONTATO,
  payload: { added_tags: added, tags: added }, metadata: {}, consumed_by: [], attempts: 0,
});

type Banco = {
  opcao?: { enabled: boolean } | null;
  etiquetas?: string[];
  negocios?: Array<{ id: string; custom_fields: unknown; crm_pipelines: { name: string; slug: string } }>;
  abertos?: Array<{ id: string }>;
  erroEm?: string;
};

const LINHA_A: Banco = {
  opcao: { enabled: true },
  etiquetas: ["funil-a", "pix-pedido"],
  negocios: [{ id: NEGOCIO, custom_fields: { servico: "A3", preco: "R$ 697", codigo: "xjvx5klebf" }, crm_pipelines: { name: "Prospecção", slug: "prospeccao" } }],
  abertos: [],
};

/** Dublê do supabase-js: responde por tabela e guarda filtros e inserts. */
function dublar(b: Banco) {
  const inserts: Array<Record<string, unknown>> = [];
  const filtros: Array<{ tabela: string; coluna: string; valor: unknown }> = [];
  const tabelas: string[] = [];
  const from = (tabela: string) => {
    tabelas.push(tabela);
    const resposta = () => {
      if (b.erroEm === tabela) return { data: null, error: { message: "detalhe-do-provedor" } };
      if (tabela === "org_guardrail_layers") return { data: b.opcao ?? null, error: null };
      if (tabela === "contacts") return { data: { tags: b.etiquetas ?? [] }, error: null };
      if (tabela === "crm_leads") return { data: b.negocios ?? [], error: null };
      return { data: b.abertos ?? [], error: null };
    };
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (coluna: string, valor: unknown) => { filtros.push({ tabela, coluna, valor }); return q; },
      limit: () => Promise.resolve(resposta()),
      maybeSingle: () => Promise.resolve(resposta()),
      insert: (linha: Record<string, unknown>) => { inserts.push(linha); return Promise.resolve({ error: b.erroEm === "insert" ? { message: "detalhe-do-provedor" } : null }); },
    };
    return q;
  };
  return { admin: { from } as never, inserts, filtros, tabelas };
}

describe("ganhouPixPedido", () => {
  it.each([[["pix-pedido"]], [["outra", "PIX-PEDIDO"]], [[" pix-pedido "]]])("sim: %j", (t) => expect(ganhouPixPedido({ added_tags: t })).toBe(true));
  it.each([[["pix"]], [[]], [null], ["pix-pedido"], [[7]]])("não: %j", (t) => expect(ganhouPixPedido({ added_tags: t })).toBe(false));
});

describe("corpoDoPixPedido", () => {
  it("leva serviço, preço, código e a referência; nada da pessoa", () => {
    const corpo = corpoDoPixPedido({ servico: "A3", preco: "R$ 697", codigo: "xjvx5klebf", marca: "ELÉTRICA PEREIRA", telefone: "+5588999991234" });
    expect(corpo).toContain("Serviço: A3");
    expect(corpo).toContain("Preço: R$ 697");
    expect(corpo).toContain("Código: xjvx5klebf");
    expect(corpo).toContain("funilA:xjvx5klebf");
    expect(corpo).not.toMatch(/PEREIRA|5588/u);
  });
  it("campo vazio aparece como vazio, e sem código não inventa referência", () => {
    const corpo = corpoDoPixPedido({ servico: "A1" });
    expect(corpo).toContain("Preço: (vazio)");
    expect(corpo).not.toContain("funilA:");
  });
});

describe("pix-pedido na Central — o consumidor", () => {
  it("opção ligada, contato da Linha A: abre UM aviso crítico no negócio, e mais nada", async () => {
    const { admin, inserts, filtros, tabelas } = dublar(LINHA_A);
    expect(await tratarPixPedido(admin, evento(["pix-pedido"]))).toMatchObject({ status: "ok", detail: "aviso_aberto" });
    expect(inserts).toEqual([{
      organization_id: ORG, kind: "other", severity: "critical", title: TITULO_DO_PIX_PEDIDO,
      body: expect.stringContaining("funilA:xjvx5klebf"), ref_kind: "lead", ref_id: NEGOCIO,
    }]);
    // não transfere, não cala a IA, não move etapa, não manda mensagem: só estas tabelas, e só um insert
    expect([...new Set(tabelas)].sort()).toEqual(["agent_inbox_items", "contacts", "crm_leads", "org_guardrail_layers"]);
    // toda leitura filtra a organização do evento
    for (const t of ["org_guardrail_layers", "contacts", "crm_leads", "agent_inbox_items"]) {
      expect(filtros).toContainEqual({ tabela: t, coluna: "organization_id", valor: ORG });
    }
    expect(filtros).toContainEqual({ tabela: "org_guardrail_layers", coluna: "layer", valor: OPCAO_PIX_PEDIDO_NA_CENTRAL });
    expect(filtros).toContainEqual({ tabela: "crm_leads", coluna: "status", valor: "open" });
  });

  it("outra etiqueta: nem lê o banco", async () => {
    const { admin, tabelas, inserts } = dublar(LINHA_A);
    expect(await tratarPixPedido(admin, evento(["sair"]))).toMatchObject({ status: "skipped", detail: "outra_etiqueta" });
    expect(tabelas).toEqual([]);
    expect(inserts).toEqual([]);
  });

  it.each<[string, Banco, string]>([
    ["opção sem linha (o estado de todo deploy)", { ...LINHA_A, opcao: null }, "opcao_desligada"],
    ["opção com enabled=false", { ...LINHA_A, opcao: { enabled: false } }, "opcao_desligada"],
    ["contato sem funil-a", { ...LINHA_A, etiquetas: ["pix-pedido"] }, "contato_fora_da_linha_a"],
    ["sem negócio aberto", { ...LINHA_A, negocios: [] }, "sem_negocio_da_linha_a"],
    ["negócio aberto só em outro funil", { ...LINHA_A, negocios: [{ ...LINHA_A.negocios![0]!, crm_pipelines: { name: "Vendas", slug: "vendas" } }] }, "sem_negocio_da_linha_a"],
    ["aviso já aberto para o negócio", { ...LINHA_A, abertos: [{ id: "x" }] }, "aviso_ja_aberto"],
  ])("%s: não abre nada", async (_nome, banco, detalhe) => {
    const { admin, inserts } = dublar(banco);
    expect(await tratarPixPedido(admin, evento(["pix-pedido"]))).toMatchObject({ status: "skipped", detail: detalhe });
    expect(inserts).toEqual([]);
  });

  it("opção desligada custa uma leitura só", async () => {
    const { admin, tabelas } = dublar({ ...LINHA_A, opcao: null });
    await tratarPixPedido(admin, evento(["pix-pedido"]));
    expect(tabelas).toEqual(["org_guardrail_layers"]);
  });

  it("dois negócios abertos na Prospecção: avisa e diz que há mais de um", async () => {
    const { admin, inserts } = dublar({ ...LINHA_A, negocios: [LINHA_A.negocios![0]!, { ...LINHA_A.negocios![0]!, id: "outro" }] });
    expect((await tratarPixPedido(admin, evento(["pix-pedido"]))).status).toBe("ok");
    expect(String(inserts[0]!.body)).toContain("2 negócios abertos");
  });

  it.each(["org_guardrail_layers", "contacts", "crm_leads", "agent_inbox_items", "insert"])("falha em %s: error (o dreno tenta de novo), sem texto livre", async (onde) => {
    const { admin } = dublar({ ...LINHA_A, erroEm: onde });
    const r = await tratarPixPedido(admin, evento(["pix-pedido"]));
    expect(r.status).toBe("error");
    expect(r.detail).not.toContain("detalhe-do-provedor");
  });

  it("o handler escuta só contact.tag_added e roda com a organização parada", () => {
    expect(pixPedidoNaCentralHandler.events).toEqual(["contact.tag_added"]);
    expect(pixPedidoNaCentralHandler.naOrgParada).toBe("roda");
    expect(vi.isMockFunction(pixPedidoNaCentralHandler.handle)).toBe(false);
  });
});
