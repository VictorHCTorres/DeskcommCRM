/**
 * A chave externa da tarefa (D9): `crm_tasks.external_id`.
 *
 * Quem grava tarefa por token (os robôs do n8n, o importador) manda uma chave
 * que ele mesmo calcula ("dctfweb:12.345.678/0001-90:2026-12"). O BANCO garante
 * que a chave não se repete na organização; a rota só traduz o conflito.
 *
 * A regra de forma mora em DOIS lugares que precisam concordar: aqui (para
 * recusar com 422 antes de gravar) e na constraint `crm_tasks_external_id_formato`
 * da migration 9338. Aqui nada é aparado em silêncio: valor com espaço nas
 * pontas é recusado, porque aparar faria "a " e "a" virarem a mesma chave sem
 * que o robô soubesse.
 */
import { z } from "zod";

/** O nome do índice único: a rota reconhece o conflito por ele, não por qualquer 23505. */
export const INDICE_DA_CHAVE_EXTERNA = "crm_tasks_org_external_id_unique";

/** O cabeçalho que diz "esta versão do CRM entende `external_id`". Ver o contrato D9 §3. */
export const CABECALHO_DA_CAPACIDADE = "x-tasks-external-id";

/** A mensagem do 422 quando a sessão do navegador manda `external_id`. */
export const CHAVE_SO_POR_TOKEN =
  "A chave externa só pode ser gravada por token de servidor (dsk_…), não pela sessão do navegador.";

export const TAMANHO_MAXIMO_DA_CHAVE = 200;
export const MAXIMO_DE_CHAVES_NO_FILTRO = 100;

/**
 * O DOMÍNIO da chave: uma LISTA DE CARACTERES PERMITIDOS, idêntica à da constraint
 * `crm_tasks_external_id_formato` (migration 9338) — se mudar aqui, mude lá (o invariante
 * `tests/invariants/tarefas-chave-externa.test.ts` compara, ponto de código a ponto de código,
 * o que o Postgres aceita com o que esta regra aceita, de U+0001 a U+10FFFF):
 *  · ASCII: letras A–Z e a–z, dígitos 0–9 (a classe explícita, nunca `\d`, que no Unicode casa
 *    dígitos de outras escritas) e a pontuação `| / . : -`;
 *  · as letras pré-compostas do Latin-1, U+00C0–U+00FF, menos o `×` (U+00D7) e o `÷` (U+00F7);
 *  · NENHUM espaço (decisão do coordenador, 11/11/2026: começar estreito — alargar depois é
 *    compatível, estreitar não é; as chaves reais não têm espaço).
 * Fica de fora tudo o mais: espaço, marcas combinantes, outras escritas, largura zero, surrogate
 * isolado, emoji, e `* " \ , ( ) + % ? # & = _` e a crase. Por que uma lista e não "tudo menos o
 * proibido": a forma normal NFC não é a mesma no PostgreSQL 15 e no Node (Unicode 17): o cxj achou
 * 20 caracteres em que as duas divergem (D9v2-2). A letra pré-composta do Latin-1 é NFC em qualquer
 * versão do Unicode, então a questão deixa de existir; ninguém precisa de `normalize()`.
 */
const LETRAS = "A-Za-z0-9\\u00c0-\\u00d6\\u00d8-\\u00f6\\u00f8-\\u00ff";
// O hífen vai por ÚLTIMO na classe (literal).
const CLASSE = `[${LETRAS}|/.:-]`;

/** A chave inteira e o prefixo têm o mesmo domínio (sem espaço, não há regra de pontas). */
export const REGEX_DA_CHAVE = new RegExp(`^${CLASSE}+$`);
export const REGEX_DO_PREFIXO = REGEX_DA_CHAVE;

/** Conta pontos de código, como o `char_length` do Postgres (não unidades UTF-16). */
function tamanho(valor: string): number {
  return Array.from(valor).length;
}

const MENSAGEM_DO_DOMINIO =
  "A chave só pode ter letras (A–Z, a–z e as acentuadas do Latin-1, como ç e ã), dígitos de 0 a 9 " +
  "e os sinais | / . : - (sem espaço).";

function comRegrasComuns(base: z.ZodString, regex: RegExp) {
  return base
    .refine((v) => tamanho(v) >= 1, { message: "A chave não pode ser vazia." })
    .refine((v) => tamanho(v) <= TAMANHO_MAXIMO_DA_CHAVE, {
      message: `A chave tem no máximo ${TAMANHO_MAXIMO_DA_CHAVE} caracteres.`,
    })
    .refine((v) => regex.test(v), { message: MENSAGEM_DO_DOMINIO });
}

/** A chave de uma tarefa: o domínio inteiro, idêntico à constraint do banco. */
export const chaveExternaSchema = comRegrasComuns(z.string(), REGEX_DA_CHAVE);

/** O prefixo do filtro: o mesmo domínio (um pedaço de chave). */
export const prefixoDeChaveSchema = comRegrasComuns(z.string(), REGEX_DO_PREFIXO);

/**
 * O valor do filtro `in` na gramática do PostgREST: `("a","b")`, cada valor SEMPRE entre aspas, com
 * `\` e `"` escapados (nessa ordem). O `.in()` do supabase-js só põe aspas em valor com `,()` e não
 * escapa `"` nem `\`: o PostgREST então lê OUTRA expressão (D9v2-1: 200 com total 0 e a linha
 * existindo, ou a chave de outra linha). Com o domínio fechado, `"` e `\` nem chegam aqui (422);
 * a serialização correta fica como defesa e é provada no gate por uma tabela sem a constraint.
 */
export function valorDoFiltroIn(valores: readonly string[]): string {
  const um = (v: string) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return `(${valores.map(um).join(",")})`;
}

/** Escapa `\`, `%` e `_` para o valor entrar num `ilike`/`like` como texto literal. */
export function escaparParaLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * É a violação do ÍNDICE DA CHAVE (e não de outra unicidade da tabela)?
 *
 * Pelo NOME EXATO da restrição na `message` do PostgreSQL, que é sempre
 * `duplicate key value violates unique constraint "<nome>"`. NUNCA por substring sobre `message` +
 * `details`: o `details` ("Key (title)=(…) already exists.") carrega DADO DA LINHA, e um título
 * escrito como o nome do nosso índice fazia outro 23505 virar "conflito da chave" (cxj D9v3-5:
 * 503 em vez de 500). Mensagem em outro idioma ou de outro formato não é reconhecida: o erro
 * sobe como 500, que é o lado seguro (nunca um 409 que não é).
 */
export function ehConflitoDaChave(
  erro: { code?: string; message?: string; details?: string | null } | null | undefined,
): boolean {
  if (!erro || erro.code !== "23505") return false;
  return erro.message === `duplicate key value violates unique constraint "${INDICE_DA_CHAVE_EXTERNA}"`;
}

/**
 * O ORÇAMENTO DO FILTRO DO GET, em BYTES (D9 v4, cxj D9v3-2).
 *
 * O limite de contagem (100 valores) não protege o transporte: o PostgREST devolve a URL inteira em
 * `Content-Location`, e o `fetch` do Node recusa resposta com mais de 16 KiB de cabeçalhos
 * (`UND_ERR_HEADERS_OVERFLOW`); dez chaves acentuadas de 193 letras já estouravam. A MEDIDA é a que
 * o consumidor calcula sozinho, sem conhecer a URL interna: a soma de `len(encodeURIComponent(valor))`
 * de todos os valores de `external_id` do GET, mais o `external_id_prefix` (conta igual).
 *
 * O número 4096 foi escolhido sobre uma MEDIDA contra PostgREST 13.0.7 e o `fetch` do Node 24.13 com
 * o limite padrão (docs/D9-tarefas-chave-unica/PROVAS-D9.md, v4): na pior forma (letras acentuadas,
 * 6 bytes cada) o transporte quebra a partir de uma soma de ~7,9 mil; o orçamento é ~52% disso. A
 * margem cobre também o que NÃO foi medido (um proxy entre o app e o Supabase com limite próprio
 * para a linha de requisição, como os 8 KiB usuais): com 100 valores a URL interna fica em ~5,5 KiB.
 * Quem publica o número para os consumidores é `chaves-amostras.json` (`limite_get`), que lê desta
 * constante no gate; os robôs leem o campo, não cravam o número.
 */
export const LIMITE_DE_BYTES_DO_FILTRO = 4096;

/** A frase exata da medida, publicada no contrato e em `chaves-amostras.json` (`limite_get.medida`). */
export const MEDIDA_DO_FILTRO =
  "soma de len(encodeURIComponent(valor)) de todos os valores de external_id do GET, mais o valor de external_id_prefix (conta igual)";

/** A soma do orçamento: o que o consumidor calcula. */
export function medidaDoFiltro(
  chaves: readonly string[] | undefined,
  prefixo: string | undefined,
): number {
  let soma = 0;
  for (const valor of chaves ?? []) soma += encodeURIComponent(valor).length;
  if (prefixo !== undefined) soma += encodeURIComponent(prefixo).length;
  return soma;
}

/** Põe o sinal de capacidade em QUALQUER resposta, inclusive a recusa da autenticação. */
export function comSinalDeCapacidade(res: Response): Response {
  try {
    res.headers.set(CABECALHO_DA_CAPACIDADE, "1");
    return res;
  } catch {
    // Resposta com cabeçalhos imutáveis (vinda de `fetch`/`redirect`): copia.
    const copia = new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
    copia.headers.set(CABECALHO_DA_CAPACIDADE, "1");
    return copia;
  }
}
