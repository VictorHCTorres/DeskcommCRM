// @vitest-environment node
/**
 * D9 v4 — MEDIDA do que o transporte aguenta num GET por chave (não é um teste de regressão: só roda
 * com D9_MEDIR=1, e escreve o que mediu em stdout e, se houver, em D9_MEDIR_SAIDA).
 *
 * Por que existe: o cxj (D9v3-2) mostrou que o limite de CONTAGEM (100 valores) não protege o
 * transporte: dez chaves acentuadas de 193 caracteres já estouram o limite de cabeçalhos do `fetch`
 * do Node (16 KiB por padrão, `UND_ERR_HEADERS_OVERFLOW`) porque o PostgREST devolve a URL inteira em
 * `Content-Location` (~2x a URL de ida). A rota agora recusa com 422 acima de um ORÇAMENTO em bytes;
 * este arquivo mede, contra o PostgREST real e o `fetch` real com o limite padrão, o ponto em que o
 * transporte realmente quebra, para o orçamento ser escolhido com MARGEM sobre um número medido.
 *
 * A consulta é a MESMA cadeia da rota (select com `count`, `eq`, duas ordens, `limit`, filtro `in`
 * via `valorDoFiltroIn`); o orçamento da rota não entra aqui (a rota recusaria antes).
 */
import { createHmac } from "node:crypto";
import { appendFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import { describe, it } from "vitest";

import { valorDoFiltroIn } from "@/lib/tarefas/chave-externa";
import { COLUNAS_DA_TAREFA } from "@/lib/tarefas/gravar-tarefa";

const URL_REST = process.env.D9_POSTGREST_URL ?? "";
const SEGREDO = process.env.D9_JWT_SECRET ?? "";
const SAIDA = process.env.D9_MEDIR_SAIDA ?? "";
const ORG = "d9a00000-0000-4000-8000-00000000000a";

function jwt(): string {
  const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const c = enc({ alg: "HS256", typ: "JWT" });
  const b = enc({ role: "service_role", sub: ORG, exp: Math.floor(Date.now() / 1000) + 3600 });
  return `${c}.${b}.${createHmac("sha256", SEGREDO).update(`${c}.${b}`).digest("base64url")}`;
}

/** O tamanho que o consumidor calcula sozinho: len(encodeURIComponent(valor)), somado. */
const medida = (valores: string[]) =>
  valores.reduce((soma, v) => soma + encodeURIComponent(v).length, 0);

/** N chaves, todas com o mesmo tamanho codificado `e` (acentuadas: 6 por letra; ASCII: 1). */
function lote(n: number, e: number, acentuada: boolean): string[] {
  return Array.from({ length: n }, (_, i) => {
    const base = `k:${i}:`;
    const falta = Math.max(1, e - encodeURIComponent(base).length);
    return acentuada
      ? base + "á".repeat(Math.floor(falta / 6)) + "a".repeat(falta % 6)
      : base + "a".repeat(falta);
  });
}

async function tenta(valores: string[]): Promise<{ ok: boolean; erro: string; urlInterna: number }> {
  let urlInterna = 0;
  const cliente = createClient(URL_REST, jwt(), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (url, opts) => {
        urlInterna = String(url).length;
        return fetch(String(url).replace("/rest/v1/", "/"), opts);
      },
    },
  });
  const { error, status } = await cliente
    .from("crm_tasks")
    .select(COLUNAS_DA_TAREFA, { count: "exact" })
    .eq("organization_id", ORG)
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(500)
    .filter("external_id", "in", valorDoFiltroIn(valores));
  return { ok: !error && status === 200, erro: error ? `${error.message} ${error.code ?? ""}`.trim() : "", urlInterna };
}

function registra(obj: Record<string, unknown>) {
  const linha = JSON.stringify(obj);
  console.info(linha);
  if (SAIDA) appendFileSync(SAIDA, `${linha}\n`);
}

describe.skipIf(process.env.D9_MEDIR !== "1")("medida do transporte do GET por chave", () => {
  const formas: Array<[number, boolean]> = [
    [1, false],
    [1, true],
    [10, true],
    [10, false],
    [50, true],
    [100, true],
    [100, false],
  ];
  it.each(formas)("limite de S (soma codificada) com %i chave(s), acentuada=%s", async (n, acentuada) => {
    // busca binária do MAIOR S que passa, entre o mínimo e o máximo que o domínio deixa montar
    const maxPorChave = acentuada ? 200 * 6 : 200;
    let baixo = n * 8;
    let alto = n * maxPorChave;
    const topo = await tenta(lote(n, maxPorChave, acentuada));
    if (topo.ok) {
      registra({ n, acentuada, maiorSQuePassa: medida(lote(n, maxPorChave, acentuada)), nota: "passa até o máximo do domínio", urlInterna: topo.urlInterna });
      return;
    }
    while (alto - baixo > n) {
      const meio = Math.floor((baixo + alto) / 2);
      const r = await tenta(lote(n, Math.floor(meio / n), acentuada));
      if (r.ok) baixo = meio;
      else alto = meio;
    }
    const e = Math.floor(baixo / n);
    const passa = lote(n, e, acentuada);
    const falha = lote(n, e + Math.max(1, Math.ceil(n / n)) * 6, acentuada);
    const rp = await tenta(passa);
    const rf = await tenta(falha);
    registra({
      n,
      acentuada,
      maiorSQuePassa: medida(passa),
      urlInternaNoLimite: rp.urlInterna,
      primeiroSQueFalha: medida(falha),
      erroNaFalha: rf.erro,
    });
  });
});
