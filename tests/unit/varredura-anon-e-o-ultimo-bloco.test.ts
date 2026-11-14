/**
 * A VARREDURA DE `anon` É O ÚLTIMO BLOCO DO BASELINE — E TEM QUE CONTINUAR SENDO.
 *
 * O `baseline.sql` traz, no corpo vindo do `pg_dump` do Supabase:
 *
 *     ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
 *       GRANT ALL ON FUNCTIONS TO anon;
 *
 * Isso não é uma linha cujo efeito acaba quando ela passa: grava uma entrada em
 * `pg_default_acl`, que fica no catálogo do banco. Depois que ela roda uma vez,
 * toda função criada em `public` a partir dali NASCE com `EXECUTE` para `anon` —
 * inclusive as de todo apêndice futuro. Numa instalação nova não incomoda (o
 * dump cria as funções antes da linha); em quem ATUALIZA, incomoda sempre.
 *
 * A cura (migration 0116) é uma varredura auto-curativa no fim do apêndice: ela
 * percorre todas as `security definer` de `public` e tira `anon`, preservando o
 * privilégio efetivo de `authenticated` e `service_role`. Funciona para função
 * que ainda nem existe — desde que rode DEPOIS de quem a cria.
 *
 * ## O defeito que este arquivo previne
 *
 * O apêndice do baseline cresce por acréscimo: cada migration cola o seu bloco
 * no fim do arquivo. É o movimento natural, e é exatamente o que desarma a cura
 * — um `create or replace function` colado ABAIXO da varredura cria a função com
 * `anon` no ACL e não há mais nada depois para tirar. O buraco volta calado, com
 * o gate verde: `install`/`update` do `scripts/test-db.sh` passam (a DDL é
 * válida), e `tests/invariants/hardening-definer-varredura.test.ts` também, se a
 * função nova ficar fora do que aquele invariante alcança.
 *
 * Não é hipótese de laboratório: é a diferença entre `install` e `update` já
 * medida numa VPS real em 2026-08-07 — 6 definer expostas a `anon`, entre elas
 * `fn_decrypt_oauth`, alcançável pela anon key, que vai para o browser.
 *
 * ## Por que estático
 *
 * A ordem dos blocos é uma propriedade do ARQUIVO, não do banco. Um teste em
 * Postgres mediria o estado final depois de aplicar tudo — e o estado final está
 * certo justamente enquanto a ordem estiver certa; ele só ficaria vermelho no dia
 * em que alguém colasse um bloco no lugar errado E o invariante de runtime desse
 * conta de olhar aquela função. Aqui a regra é medida onde ela mora: no texto.
 *
 * ## A regra
 *
 * Apêndice novo entra ANTES do bloco da varredura. Nenhuma função é criada
 * depois dele, e nenhum `grant` devolve `anon` depois dele.
 *
 * ## No fork (canal da Suindara): duas varreduras
 *
 * O baseline do fork tem DUAS cópias do bloco. A primeira fica onde o upstream a
 * mantém (logo depois do último apêndice de função dele — testes do upstream
 * fatiam o arquivo "do meu bloco até a VARREDURA" e dependem disso), com o
 * cabeçalho dele, `-- ---- VARREDURA anon:`. A segunda fecha o apêndice próprio
 * do fork, que NÃO pode subir para antes da primeira: os blocos do fork dependem
 * do miolo que vem depois dela (0237…9084 — o gatilho de subtarefa lê
 * `crm_tasks.demanda_id`, que nasce na 0659). Ela tem cabeçalho PRÓPRIO,
 * `-- ---- VARREDURA anon do fork`, para os testes do upstream que ancoram em
 * "VARREDURA anon:" seguirem achando uma só (a cerca
 * `sonda-do-baseline-ancora-na-ultima-definicao` reprova âncora em texto repetido).
 *
 * A régua de função passa a ser medida na varredura que roda POR ÚLTIMO (é ela
 * que cura tudo o que veio antes); a de `grant … to anon` continua na PRIMEIRA,
 * que é a régua mais estrita — a varredura só cura EXECUTE de definer, não
 * desfaz grant de tabela. E as duas cópias têm de rodar o MESMO código.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const BASELINE = join(process.cwd(), "supabase", "baseline.sql");

/** O cabeçalho do bloco da 0116, no apêndice — a cópia do upstream. */
const MARCADOR = /^-- ---- VARREDURA anon:/gm;

/** A cópia do fork, que fecha o apêndice próprio (cabeçalho distinto de propósito — ver acima). */
const MARCADOR_DO_FORK = /^-- ---- VARREDURA anon do fork/gm;

/**
 * Criação de função ancorada em INÍCIO DE LINHA, e não em qualquer ocorrência do
 * texto: o próprio comentário do bloco explica que uma lista "reabre no próximo
 * `create function`". Casar solto acusaria a prosa que descreve a regra — o
 * instrumento reprovando o arquivo por ele falar de si mesmo.
 */
const CRIA_FUNCAO = /^[ \t]*create[ \t]+(?:or[ \t]+replace[ \t]+)?function/gim;

/** Devolve `anon` a algo — o outro jeito de desfazer a varredura por baixo. */
const GRANT_PARA_ANON = /^[ \t]*grant[ \t][^;]*\bto\b[^;]*\banon\b/gim;

/** Todas as cópias, das duas marcas, em ordem de arquivo. */
function posicoesDaVarredura(sql: string): number[] {
  return [...sql.matchAll(MARCADOR), ...sql.matchAll(MARCADOR_DO_FORK)]
    .map((m) => m.index)
    .sort((a, b) => a - b);
}

/** A ÚLTIMA varredura: é ela que precisa ver toda função criada. */
function posicaoDaVarredura(sql: string): number {
  const todas = posicoesDaVarredura(sql);
  return todas.length > 0 ? todas[todas.length - 1]! : -1;
}

/** A PRIMEIRA varredura: depois dela, nenhum grant devolve `anon`. */
function posicaoDaPrimeiraVarredura(sql: string): number {
  return posicoesDaVarredura(sql)[0] ?? -1;
}

/**
 * O CÓDIGO de um bloco de varredura — do cabeçalho até o próximo cabeçalho de
 * bloco (`-- ---- `) ou o fim do arquivo —, sem comentário nem linha em branco.
 * Comparar código, e não texto, deixa as cópias terem prosa diferente.
 */
function codigoDaVarredura(sql: string, inicio: number): string {
  const resto = sql.slice(inicio);
  const proximo = resto.slice(1).search(/^-- ---- /m);
  const bloco = proximo === -1 ? resto : resto.slice(0, proximo + 1);
  return bloco
    .split("\n")
    .filter((l) => l.trim() !== "" && !l.trimStart().startsWith("--"))
    .join("\n");
}

function posicoesDe(sql: string, padrao: RegExp): number[] {
  return [...sql.matchAll(padrao)].map((m) => m.index);
}

/** Nº da linha (1-based) de um offset, para a mensagem de falha ser acionável. */
function linhaDe(sql: string, offset: number): number {
  return sql.slice(0, offset).split("\n").length;
}

describe("baseline.sql — a varredura de anon é o último bloco", () => {
  const sql = readFileSync(BASELINE, "utf8");

  it("o instrumento acha o que precisa achar (guarda de vacuidade)", () => {
    // Sem isto, um marcador renomeado ou um regex quebrado fariam as asserções
    // abaixo passarem por ausência de dado — verde por não medir nada.
    expect(
      posicaoDaVarredura(sql),
      "bloco da varredura (migration 0116) não encontrado no baseline.sql — " +
        "ele foi removido, ou o cabeçalho '-- ---- VARREDURA anon:' foi reescrito?",
    ).toBeGreaterThan(-1);
    expect(posicoesDe(sql, CRIA_FUNCAO).length).toBeGreaterThan(40);
  });

  it("nenhuma função é criada depois da varredura", () => {
    const varredura = posicaoDaVarredura(sql);
    const depois = posicoesDe(sql, CRIA_FUNCAO)
      .filter((i) => i > varredura)
      .map((i) => `linha ${linhaDe(sql, i)}`);

    expect(
      depois,
      "Função criada DEPOIS do bloco da varredura de anon (que está na linha " +
        `${linhaDe(sql, varredura)}).\n` +
        "O ALTER DEFAULT PRIVILEGES do corpo do baseline faz toda função nova nascer com\n" +
        "EXECUTE para anon; a varredura cura isso, mas só para o que veio ANTES dela.\n" +
        "Mova o apêndice novo para cima do bloco — ele é, de propósito, o último do arquivo.",
    ).toEqual([]);
  });

  it("nenhum grant devolve anon depois da varredura", () => {
    // O outro caminho para o mesmo estrago: não criar função nova, e sim
    // reconceder o que a varredura acabou de tirar. Medido da PRIMEIRA cópia.
    const varredura = posicaoDaPrimeiraVarredura(sql);
    const depois = posicoesDe(sql, GRANT_PARA_ANON)
      .filter((i) => i > varredura)
      .map((i) => `linha ${linhaDe(sql, i)}`);

    expect(depois, "grant para anon depois da varredura — a cura é desfeita no mesmo run").toEqual(
      [],
    );
  });

  it("o instrumento enxerga a violação quando ela existe (controle negativo)", () => {
    // Sabotagem: o mesmo arquivo com um bloco colado DEPOIS da varredura, que é
    // exatamente o movimento natural de quem adiciona uma migration.
    const sabotado = `${sql}\n-- ---- alguma coisa (migration 9999) ----\ncreate or replace function public.fn_sabotagem() returns int\n  language sql as $$ select 1 $$;\n\ngrant execute on function public.fn_sabotagem() to anon;\n`;

    // Contado como DELTA sobre o arquivo real, não como total absoluto: se o
    // baseline um dia estiver de fato violando a regra, quem tem de ficar
    // vermelho são os casos acima — este aqui continua medindo só o detector.
    const depois = (texto: string, padrao: RegExp, posicao: (t: string) => number) =>
      posicoesDe(texto, padrao).filter((i) => i > posicao(texto)).length;

    expect(
      depois(sabotado, CRIA_FUNCAO, posicaoDaVarredura) -
        depois(sql, CRIA_FUNCAO, posicaoDaVarredura),
    ).toBe(1);
    expect(
      depois(sabotado, GRANT_PARA_ANON, posicaoDaPrimeiraVarredura) -
        depois(sql, GRANT_PARA_ANON, posicaoDaPrimeiraVarredura),
    ).toBe(1);
  });

  it("as cópias da varredura rodam o MESMO código (fork: a do upstream e a que fecha o apêndice do fork)", () => {
    const doUpstream = [...sql.matchAll(MARCADOR)].map((m) => m.index);
    const doFork = [...sql.matchAll(MARCADOR_DO_FORK)].map((m) => m.index);
    // Uma de cada: duas com o MESMO cabeçalho fariam as âncoras do upstream mirarem texto repetido.
    expect(doUpstream.length, "cópias com o cabeçalho do upstream ('VARREDURA anon:')").toBe(1);
    expect(doFork.length, "cópias com o cabeçalho do fork ('VARREDURA anon do fork')").toBe(1);
    expect(doFork[0]!, "a cópia do fork fecha o apêndice: vem DEPOIS da do upstream").toBeGreaterThan(
      doUpstream[0]!,
    );
    const todas = posicoesDaVarredura(sql);
    const codigos = todas.map((i) => codigoDaVarredura(sql, i));
    // Controle: o extrator achou o `do $$ … end $$;` e as regras de authenticated.
    for (const c of codigos) {
      expect(c).toContain("has_function_privilege('authenticated'");
      expect(c).toContain("revoke execute on function public.fn_decrypt_oauth(bytea) from authenticated;");
    }
    expect(
      new Set(codigos).size,
      "as varreduras divergiram — o upstream mudou a dele? Copie a mudança para a do fork",
    ).toBe(1);
  });

  it("a prosa do próprio bloco não é confundida com código", () => {
    // Controle do controle: o comentário da 0116 cita "create function" e "anon"
    // em texto corrido. Se o regex casasse comentário, o teste acima ficaria
    // vermelho para sempre e alguém o "consertaria" afrouxando a regra.
    const prosa =
      "-- Lista conserta o estoque e reabre no próximo `create function`.\n" +
      "-- grant execute on function public.fn_x() to anon;\n";
    expect(posicoesDe(prosa, CRIA_FUNCAO)).toEqual([]);
    expect(posicoesDe(prosa, GRANT_PARA_ANON)).toEqual([]);
  });
});
