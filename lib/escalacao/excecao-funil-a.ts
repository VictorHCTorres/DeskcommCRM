/**
 * EXCEÇÃO DA LINHA A NA RESTRIÇÃO COMERCIAL (1.110.2).
 *
 * A trava "valores e negociação com a equipe" (`restricao_comercial`) é da
 * organização inteira: com ela ligada, quem pergunta o preço vai para uma pessoa
 * e a IA não pode dizer valor nenhum. A Linha A (aviso de publicação do INPI)
 * vende um serviço de preço FIXO, que já está gravado no negócio do contato — e a
 * agente dela precisa dizer esse preço, e só ele.
 *
 * A exceção é estreita e vale só quando TUDO abaixo é verdade:
 *   1. a organização ligou a opção (linha `restricao_comercial_excecao_funil_a`
 *      em `org_guardrail_layers`). Sem linha = DESLIGADA: o deploy sozinho não
 *      muda nada;
 *   2. o contato tem a etiqueta `funil-a`;
 *   3. existe EXATAMENTE UM negócio aberto dele no funil Prospecção;
 *   4. esse negócio tem `custom_fields.preco` preenchido e legível como dinheiro.
 *
 * Com a exceção válida:
 *   - ENTRADA: a mensagem sobre preço/valor/Pix/desconto não é desviada para a
 *     equipe; segue para a IA;
 *   - SAÍDA: a resposta só sai se passar em `conferirRespostaDaLinhaA` — todo
 *     valor igual ao `preco`, nenhuma condição comercial, nenhuma chave ou link
 *     de pagamento, nenhuma promessa. Barrada, tem o MESMO destino de hoje
 *     (`commercial_requires_human`: não sai e a conversa vai para a Central).
 *
 * Falha FECHADA: leitura que estoura, preço ilegível, dois negócios abertos —
 * qualquer dúvida devolve `null`, e `null` é a trava de sempre.
 *
 * A opção é uma LINHA nova na tabela de camadas, e não uma coluna: `layer` é de
 * vocabulário aberto (ver `camadas-da-org.ts`), então não há migration.
 */
import { CAMADA_RESTRICAO_COMERCIAL } from "@/lib/agent-engine/guardrails/camadas-da-org";

/** A opção da camada. Fora de `CAMADAS_CONFIGURAVEIS`: não tem interruptor na tela; liga-se por configuração. */
export const OPCAO_EXCECAO_FUNIL_A = `${CAMADA_RESTRICAO_COMERCIAL}_excecao_funil_a` as const;

/** A etiqueta do CONTATO que a importação da Linha A põe. */
export const ETIQUETA_FUNIL_A = "funil-a";

/** O funil da Linha A, pelo nome ou pelo slug normalizados. */
const FUNIL_PROSPECCAO = "prospeccao";

/** O que a saída precisa saber do negócio. Nada daqui é dado pessoal. */
export type ExcecaoFunilA = {
  /** O `preco` do negócio, em centavos. */
  precoCentavos: number;
  /** O `codigo` do negócio (referência `funilA:<codigo>`); `null` se vazio. */
  codigo: string | null;
  /** O `link_pagina` do negócio, o único endereço próprio que a resposta pode levar; `null` se vazio. */
  linkPagina: string | null;
};

const normalizar = (texto: string): string =>
  texto.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/gu, "");

// ─────────────────────────── dinheiro ───────────────────────────

/** Número com milhar em ponto (e centavos opcionais) ou simples com decimal opcional. */
const NUM = String.raw`\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d+(?:[.,]\d{1,2})?`;

/** "1.997,00" | "1.997" | "697,5" | "697.00" | "697" → centavos. `null` se não for número de dinheiro. */
function centavosDe(numero: string): number | null {
  const s = numero.trim();
  if (!/^\d[\d.,]*$/u.test(s) || /[.,]$/u.test(s)) return null;
  if (s.includes(",")) {
    // vírgula é decimal; ponto, milhar
    const [inteiro, decimal, ...resto] = s.split(",");
    if (resto.length > 0 || inteiro === undefined || decimal === undefined || decimal.length > 2) return null;
    if (inteiro.includes(".") && !/^\d{1,3}(?:\.\d{3})+$/u.test(inteiro)) return null;
    return Number(inteiro.replace(/\./gu, "")) * 100 + Number(decimal.padEnd(2, "0"));
  }
  if (/^\d{1,3}(?:\.\d{3})+$/u.test(s)) return Number(s.replace(/\./gu, "")) * 100;
  const m = /^(\d+)\.(\d{1,2})$/u.exec(s);
  if (m) return Number(m[1]) * 100 + Number(m[2]!.padEnd(2, "0"));
  if (/^\d+$/u.test(s)) return Number(s) * 100;
  return null;
}

/**
 * O `preco` do negócio em centavos. Aceita o que a importação grava ("R$ 697",
 * "R$ 1.997") e as formas vizinhas ("697", "697,00", 497). `null` = vazio ou
 * ilegível, e aí não há exceção.
 */
export function normalizarPreco(valor: unknown): number | null {
  if (typeof valor === "number") {
    return Number.isFinite(valor) && valor > 0 ? Math.round(valor * 100) : null;
  }
  if (typeof valor !== "string") return null;
  const limpo = normalizar(valor).replace(/r\$/gu, "").replace(/\breais\b/gu, "").replace(/\s+/gu, "");
  if (limpo === "") return null;
  const centavos = centavosDe(limpo);
  return centavos !== null && centavos > 0 ? centavos : null;
}

// ─── por extenso ───

const NUMEROS_POR_EXTENSO: Readonly<Record<string, number>> = {
  um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9,
  dez: 10, onze: 11, doze: 12, treze: 13, quatorze: 14, catorze: 14, quinze: 15, dezesseis: 16,
  dezessete: 17, dezoito: 18, dezenove: 19, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50,
  sessenta: 60, setenta: 70, oitenta: 80, noventa: 90,
  cem: 100, cento: 100, duzentos: 200, duzentas: 200, trezentos: 300, trezentas: 300,
  quatrocentos: 400, quatrocentas: 400, quinhentos: 500, quinhentas: 500, seiscentos: 600,
  seiscentas: 600, setecentos: 700, setecentas: 700, oitocentos: 800, oitocentas: 800,
  novecentos: 900, novecentas: 900,
};
const PALAVRAS_DE_MOEDA = new Set(["reais", "real", "conto", "contos", "pila", "pilas"]);

/**
 * Valores escritos por extenso. Conta como dinheiro a sequência seguida de
 * "reais" ("noventa reais") e a que tem centena ou milhar composto ("seiscentos
 * e noventa e sete", "dois mil"). "duas perguntas", "cinco dias", "cem" e "mil"
 * soltos não contam.
 */
function valoresPorExtenso(normal: string): number[] {
  const palavras = normal.split(/[^a-z0-9$]+/u).filter((p) => p !== "");
  const achados: number[] = [];
  let i = 0;
  while (i < palavras.length) {
    if (NUMEROS_POR_EXTENSO[palavras[i]!] === undefined && palavras[i] !== "mil") {
      i += 1;
      continue;
    }
    let total = 0;
    let atual = 0;
    let numericas = 0;
    let temCentena = false;
    let temMil = false;
    let j = i;
    while (j < palavras.length) {
      const p = palavras[j]!;
      const v = NUMEROS_POR_EXTENSO[p];
      if (v !== undefined) {
        atual += v;
        numericas += 1;
        if (v >= 100 && p !== "cem") temCentena = true;
      } else if (p === "mil") {
        total += (atual === 0 ? 1 : atual) * 1000;
        atual = 0;
        temMil = true;
      } else if (p === "e" && j + 1 < palavras.length
        && (NUMEROS_POR_EXTENSO[palavras[j + 1]!] !== undefined || palavras[j + 1] === "mil")) {
        // conector no meio da sequência
      } else break;
      j += 1;
    }
    const seguidaDeMoeda = j < palavras.length && PALAVRAS_DE_MOEDA.has(palavras[j]!);
    if (seguidaDeMoeda || temCentena || (temMil && numericas > 0)) achados.push((total + atual) * 100);
    i = Math.max(j, i + 1);
  }
  return achados;
}

/** O que a conferência achou de dinheiro: os valores legíveis e se houve algum ilegível. */
type Dinheiro = { centavos: number[]; ilegivel: boolean };

/** Todo valor monetário do texto (já normalizado). */
function valoresMonetarios(normal: string): Dinheiro {
  const centavos: number[] = [];
  let ilegivel = false;
  const guardar = (numero: string, mil: boolean): void => {
    const c = centavosDe(numero);
    if (c === null) ilegivel = true;
    else centavos.push(mil ? c * 1000 : c);
  };

  // "R$ 697", "R$1.997,00", "R$ 2 mil"
  for (const m of normal.matchAll(new RegExp(String.raw`r\$\s*(${NUM})(\s*mil\b)?`, "gu"))) {
    guardar(m[1]!, m[2] !== undefined);
  }
  // "R$" sem número colado ("R$ seiscentos" cai no extenso; "R$" solto é ilegível)
  for (const m of normal.matchAll(/r\$(?!\s*\d)\s*([a-z]*)/gu)) {
    if (NUMEROS_POR_EXTENSO[m[1] ?? ""] === undefined && m[1] !== "mil") ilegivel = true;
  }
  // "697 reais", "1.997,00 reais", "2 mil reais"
  for (const m of normal.matchAll(
    new RegExp(String.raw`(?<![\d.,])(${NUM})\s*(mil\s+)?(?:reais|real|contos?|pilas?)\b`, "gu"),
  )) {
    guardar(m[1]!, m[2] !== undefined);
  }
  // "2 mil", "1,5 mil"
  for (const m of normal.matchAll(new RegExp(String.raw`(?<![\d.,])(${NUM})\s*mil\b`, "gu"))) {
    guardar(m[1]!, true);
  }
  // "697,00" solto — vírgula com duas casas é preço
  for (const m of normal.matchAll(/(?<![\d.,/-])(\d{1,3}(?:\.\d{3})+|\d+),(\d{2})(?![\d])/gu)) {
    guardar(`${m[1]},${m[2]}`, false);
  }
  // inteiro em posição de preço, sem moeda: "sai por 697", "são 1.997", "custa 500"
  for (const m of normal.matchAll(
    /\b(?:por|custa|custam|custar|custara|sai|saem|fica|ficam|sao|apenas|somente|cobramos|cobro|pagar|paga|pague|(?:valor|preco|total)\s+(?:de|e))\s+(?:(?:so|apenas|somente|por|em|a|de)\s+)?(\d{1,3}(?:\.\d{3})+|\d{3,})(?![\d,]|[-/:.]\d|\s*(?:%|horas?|h\b|dias?|minutos?|anos?|meses|semanas?|vezes|x\b))/gu,
  )) {
    guardar(m[1]!, false);
  }
  centavos.push(...valoresPorExtenso(normal));
  // moeda estrangeira nunca é o preço do negócio
  if (/(?:us\$|€|£)|\b(?:dolar(?:es)?|dollars?|euros?|usd|eur)\b/u.test(normal)) ilegivel = true;
  return { centavos, ilegivel };
}

// ─────────────────────────── o que não pode ───────────────────────────

/** Condição comercial que a Linha A não tem: nem para recusar a agente escreve estas palavras. */
const CONDICOES_PROIBIDAS: ReadonlyArray<readonly [string, RegExp]> = [
  ["desconto", /\bdescont\w*/u],
  ["abatimento", /\babat(?:imento|er|e|o|emos)\w*/u],
  ["promocao", /\bpromoc\w*/u],
  ["parcelamento", /\bparcel\w*/u],
  ["n_vezes", /\b(?:\d{1,2}|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s*vezes\b/u],
  ["n_x", /\b\d{1,2}\s*x(?![a-z])/u],
  ["juros", /\bjuros\b/u],
  ["cartao", /\bcart(?:ao|oes)\b|\b(?:credito|debito)\b/u],
  ["boleto", /\bboleto\w*/u],
  ["porcentagem", /%|\bpor\s*cento\b/u],
  ["de_por", /\bde\s+r\$[^.!?\n]{0,40}\bpor\b/u],
  ["gratis", /\bgratis\b|\bgratuit\w*|\bde\s+graca\b/u],
];

/** Promessa de resultado. */
const PROMESSAS_PROIBIDAS: ReadonlyArray<readonly [string, RegExp]> = [
  ["garantia", /\bgarant\w*/u],
  ["aprovacao_certa", /\baprovacao\s+(?:certa|garantida|segura)\b|\bcerteza\s+d[ea]\s+aprovacao\b/u],
  ["tudo_incluido", /\btud[oa]\s+inclu(?:id|s)[oa]s?\b/u],
];

/** Chave Pix, copia-e-cola e link de pagamento: quem manda a cobrança é uma pessoa. */
const MEIOS_DE_PAGAMENTO_PROIBIDOS: ReadonlyArray<readonly [string, RegExp]> = [
  ["chave_pix", /\bchave\s+(?:d[oea]\s+)?pix\b|\bpix\s+(?:copia|chave)\b|\bcodigo\s+(?:d[oe]\s+)?pix\b/u],
  ["copia_e_cola", /\bcopia\s*(?:e|-e-|-)?\s*cola\b|000201\d{2}|br\.gov\.bcb\.pix|\bqr\s*code\b|\blinha\s+digitavel\b/u],
  ["link_de_pagamento", /\blink\s+(?:de|do|da|para|pra)\s+(?:o\s+)?(?:pagamento|pagar|pix|cobranca)\b/u],
  ["email", /[a-z0-9._%+-]+@[a-z0-9-]+\.[a-z0-9.-]+/u],
  ["chave_aleatoria", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/u],
  ["cpf", /(?<!\d)\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/u],
  ["telefone", /(?<![\d.])(?:\+?55\s*)?\(?\d{2}\)?\s*9\s?\d{4}[-\s]?\d{4}(?!\d)/u],
];

/** Endereço (com ou sem http) escrito no texto. */
const ENDERECO = /(?:https?:\/\/|www\.)[^\s<>"')\]]+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|br|io|app|me|link|ly|co|page|site|online|store|shop|pay|dev|info)\b(?:\/[^\s<>"')\]]*)?/gu;

const semProtocolo = (url: string): string =>
  url.replace(/^https?:\/\//u, "").replace(/^www\./u, "").replace(/[.,;:!?]+$/u, "").replace(/\/+$/u, "");

/** O endereço é do INPI ou é exatamente o `link_pagina` do negócio? */
function enderecoPermitido(url: string, linkPagina: string | null): boolean {
  const limpo = semProtocolo(url);
  const host = limpo.split(/[/?#]/u)[0] ?? "";
  if (host === "inpi.gov.br" || host.endsWith(".inpi.gov.br")) return true;
  return linkPagina !== null && limpo === semProtocolo(normalizar(linkPagina.trim()));
}

export type ConferenciaDaLinhaA = { ok: true } | { ok: false; motivos: string[] };

/**
 * A resposta pode sair para um contato da Linha A? Função pura.
 *
 * `motivos` são rótulos NOSSOS e fechados (vão para log e auditoria); o trecho
 * barrado nunca sai daqui.
 */
export function conferirRespostaDaLinhaA(body: string, excecao: ExcecaoFunilA): ConferenciaDaLinhaA {
  const normal = normalizar(body);
  const motivos: string[] = [];

  const dinheiro = valoresMonetarios(normal);
  if (dinheiro.ilegivel) motivos.push("valor_ilegivel");
  if (dinheiro.centavos.some((c) => c !== excecao.precoCentavos)) motivos.push("valor_diferente_do_preco");

  for (const [rotulo, re] of [...CONDICOES_PROIBIDAS, ...PROMESSAS_PROIBIDAS, ...MEIOS_DE_PAGAMENTO_PROIBIDOS]) {
    if (re.test(normal)) motivos.push(rotulo);
  }

  for (const m of normal.matchAll(ENDERECO)) {
    if (!enderecoPermitido(m[0], excecao.linkPagina)) {
      motivos.push("endereco_nao_permitido");
      break;
    }
  }

  // Referência: toda `funilA:<x>` tem de ser a do negócio; e quem fala em
  // "referência" tem de trazer a do negócio.
  const codigo = excecao.codigo === null ? null : normalizar(excecao.codigo.trim());
  const referencias = [...normal.matchAll(/\bfunila\s*:\s*([a-z0-9_-]*)/gu)].map((m) => m[1] ?? "");
  if (referencias.some((r) => codigo === null || r !== codigo)) motivos.push("referencia_diferente_do_codigo");
  else if (/\breferencia\b/u.test(normal) && referencias.length === 0) motivos.push("referencia_sem_codigo");

  return motivos.length === 0 ? { ok: true } : { ok: false, motivos: [...new Set(motivos)] };
}

// ─────────────────────────── a condição ───────────────────────────

/** O que a leitura traz do banco, antes de decidir. */
export type FatosDaExcecao = {
  /** A linha da opção em `org_guardrail_layers` (`enabled`). */
  opcaoLigada: boolean;
  /** As etiquetas do contato. */
  etiquetas: readonly string[];
  /** Os negócios ABERTOS do contato, com o funil de cada um. */
  negociosAbertos: ReadonlyArray<{ funilNome: string | null; funilSlug: string | null; campos: unknown }>;
};

const textoDoCampo = (campos: unknown, chave: string): string | null => {
  if (typeof campos !== "object" || campos === null || Array.isArray(campos)) return null;
  const v = (campos as Record<string, unknown>)[chave];
  if (typeof v === "number") return String(v);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
};

const ehProspeccao = (n: { funilNome: string | null; funilSlug: string | null }): boolean =>
  normalizar((n.funilNome ?? "").trim()) === FUNIL_PROSPECCAO || (n.funilSlug ?? "").trim().toLowerCase() === FUNIL_PROSPECCAO;

/** A condição inteira, sem banco. `null` = não há exceção; vale a trava de sempre. */
export function resolverExcecaoFunilA(fatos: FatosDaExcecao): ExcecaoFunilA | null {
  if (!fatos.opcaoLigada) return null;
  if (!fatos.etiquetas.some((e) => e.trim().toLowerCase() === ETIQUETA_FUNIL_A)) return null;
  const daProspeccao = fatos.negociosAbertos.filter(ehProspeccao);
  if (daProspeccao.length !== 1) return null;
  const campos = daProspeccao[0]!.campos;
  const precoCentavos = normalizarPreco(
    typeof campos === "object" && campos !== null ? (campos as Record<string, unknown>).preco : null,
  );
  if (precoCentavos === null) return null;
  return { precoCentavos, codigo: textoDoCampo(campos, "codigo"), linkPagina: textoDoCampo(campos, "link_pagina") };
}

type Db = { query: (sql: string, values: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * A exceção deste contato, lida do banco. Só deve ser chamada com a restrição
 * comercial LIGADA — sem ela não há o que excetuar.
 *
 * Duas consultas, e a segunda só roda para a organização que ligou a opção: quem
 * não ligou paga uma leitura por chave primária e nada mais.
 *
 * Falha FECHADA: erro de leitura vira `null` (a trava de sempre), com aviso.
 */
export async function lerExcecaoFunilA(
  db: Db,
  organizationId: string,
  contactId: string,
  avisar?: (mensagem: string, contexto: Record<string, unknown>) => void,
): Promise<ExcecaoFunilA | null> {
  try {
    const opcao = await db.query(
      "select enabled from org_guardrail_layers where organization_id = $1 and layer = $2",
      [organizationId, OPCAO_EXCECAO_FUNIL_A],
    );
    if (opcao.rows[0]?.enabled !== true) return null;
    const { rows } = await db.query(
      `select c.tags as etiquetas,
              coalesce((
                select jsonb_agg(jsonb_build_object('funil_nome', p.name, 'funil_slug', p.slug, 'campos', l.custom_fields))
                  from crm_leads l
                  join crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
                 where l.organization_id = c.organization_id and l.contact_id = c.id and l.status = 'open'
              ), '[]'::jsonb) as negocios
         from contacts c
        where c.organization_id = $1 and c.id = $2`,
      [organizationId, contactId],
    );
    const linha = rows[0];
    if (linha === undefined) return null;
    const negocios = Array.isArray(linha.negocios) ? (linha.negocios as Array<Record<string, unknown>>) : [];
    return resolverExcecaoFunilA({
      opcaoLigada: true,
      etiquetas: Array.isArray(linha.etiquetas) ? (linha.etiquetas as unknown[]).filter((e): e is string => typeof e === "string") : [],
      negociosAbertos: negocios.map((n) => ({
        funilNome: typeof n.funil_nome === "string" ? n.funil_nome : null,
        funilSlug: typeof n.funil_slug === "string" ? n.funil_slug : null,
        campos: n.campos,
      })),
    });
  } catch (err) {
    avisar?.("exceção da Linha A não lida — vale a restrição comercial de sempre (falha fechada)", {
      error: err instanceof Error ? err.message.slice(0, 120) : "erro desconhecido",
    });
    return null;
  }
}
