/**
 * A chave externa da tarefa (D9): `crm_tasks.external_id`.
 *
 * Quem grava tarefa por token (os robôs do n8n, o importador) manda uma chave
 * que ele mesmo calcula ("dctfweb:12.345.678/0001-90:2026-12"). O BANCO garante
 * que a chave não se repete na organização; a rota só traduz o conflito.
 *
 * A regra de forma mora em DOIS lugares que precisam concordar: aqui (para
 * recusar com 422 antes de gravar) e na constraint `crm_tasks_external_id_formato`
 * da migration 9252. Aqui nada é aparado em silêncio: valor com espaço nas
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

// Caracteres de controle: U+0000–U+001F e U+007F. O banco recusa o mesmo conjunto.
const CARACTERE_DE_CONTROLE = /[\u0000-\u001f\u007f]/;

/** Conta pontos de código, como o `char_length` do Postgres (não unidades UTF-16). */
function tamanho(valor: string): number {
  return Array.from(valor).length;
}

export const chaveExternaSchema = z
  .string()
  .refine((v) => tamanho(v) >= 1, { message: "A chave não pode ser vazia." })
  .refine((v) => tamanho(v) <= TAMANHO_MAXIMO_DA_CHAVE, {
    message: `A chave tem no máximo ${TAMANHO_MAXIMO_DA_CHAVE} caracteres.`,
  })
  .refine((v) => v === v.trim(), { message: "A chave não pode ter espaço no início ou no fim." })
  .refine((v) => !CARACTERE_DE_CONTROLE.test(v), {
    message: "A chave não pode ter caractere de controle.",
  });

/** Escapa `\`, `%` e `_` para o valor entrar num `ilike`/`like` como texto literal. */
export function escaparParaLike(texto: string): string {
  return texto.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * É a violação do ÍNDICE DA CHAVE (e não de outra unicidade da tabela)?
 * O PostgREST põe o nome da restrição na `message` ("duplicate key value
 * violates unique constraint \"…\""); olhamos também `details` por garantia.
 */
export function ehConflitoDaChave(
  erro: { code?: string; message?: string; details?: string | null } | null | undefined,
): boolean {
  if (!erro || erro.code !== "23505") return false;
  return `${erro.message ?? ""} ${erro.details ?? ""}`.includes(INDICE_DA_CHAVE_EXTERNA);
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
