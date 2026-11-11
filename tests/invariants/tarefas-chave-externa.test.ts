import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { beforeAll, describe, expect, it } from "vitest";

import { REGEX_DA_CHAVE } from "../../lib/tarefas/chave-externa";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * A CHAVE EXTERNA DA TAREFA (D9, migration 9252) — NO BANCO DE VERDADE, COM O BASELINE INTEIRO.
 *
 * O que as provas de unidade das rotas (`app/api/v1/tasks/route.chave-externa.test.ts`) NÃO
 * medem, porque lá o banco é falso: o índice único, a constraint de forma (a mesma regra do zod,
 * o domínio por lista de caracteres, sem normalize), a trava de quem escreve a chave e, desde a revisão do cxj, a
 * IDENTIDADE `(organization_id, external_id)` — mover a tarefa com chave para outra organização
 * pela sessão (JWT de quem está nas duas) não pode ser um jeito de ocupar/liberar a chave.
 *
 * Quem responde aqui é o Postgres: `set role authenticated|service_role` + `request.jwt.claims`,
 * o mesmo que o PostgREST faz. A RLS é a REAL (baseline). O PostgREST em si (count, embed, LIKE,
 * `*`) é provado por `scripts/test-tarefas-chave-externa-postgrest.sh`.
 *
 * Fixtures locais por id (namespace `d9`), porque o molde do banco é um por arquivo.
 */

const execFileAsync = promisify(execFile);
const container = process.env.TEST_DB_CONTAINER ?? "";

const ORG_A = GOV_ORG;
const ORG_B = "d9d9d9d9-0000-4000-8000-00000000000b";
/** Manager NAS DUAS organizações: a pré-condição que o cxj usou para mover a tarefa. */
const USER_DUAS = "d9d9d9d9-1111-4000-8000-000000000001";
/** Manager só da A: não passa na RLS da B. */
const USER_SO_A = "d9d9d9d9-1111-4000-8000-000000000002";

const T = (n: number) => `d9d9d9d9-2222-4000-8000-${String(n).padStart(12, "0")}`;

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values
      ('${USER_DUAS}', 'd9-duas@invariant.test'), ('${USER_SO_A}', 'd9-so-a@invariant.test')
      on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_B}', 'd9-org-b', 'D9 Org B', 'D9 B') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${USER_DUAS}', '${ORG_A}', 'manager', now()),
      ('${USER_DUAS}', '${ORG_B}', 'manager', now()),
      ('${USER_SO_A}', '${ORG_A}', 'manager', now())
      on conflict do nothing;
  `);
});

/** Roda o SQL e devolve o texto do erro (stderr), ou null se passou. */
function erroDe(script: string): string | null {
  try {
    sql(script);
    return null;
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? err);
  }
}

const comoSessao = (user: string, dml: string) => `
  set role authenticated;
  select set_config('request.jwt.claims', '{"sub":"${user}","role":"authenticated"}', false);
  ${dml}`;
const comoServico = (dml: string) => `set role service_role; ${dml}`;

function um(query: string): string {
  const out = sql(query);
  return out.split("\n").pop() ?? "";
}

describe("catálogo: o que a migração 9252 tem de ter deixado", () => {
  it("coluna, constraint validada, índice único parcial válido e o gatilho", () => {
    expect(
      um(`select data_type from information_schema.columns
           where table_name='crm_tasks' and column_name='external_id'`),
    ).toBe("text");
    expect(
      um(`select convalidated::text from pg_constraint
           where conname='crm_tasks_external_id_formato' and conrelid='public.crm_tasks'::regclass`),
    ).toBe("true");
    const indice = um(`select i.indisunique::text || ',' || i.indisvalid::text || ',' ||
        pg_get_expr(i.indpred, i.indrelid) || ',' ||
        (select string_agg(a.attname, ',' order by k.ord)
           from unnest(i.indkey) with ordinality k(attnum, ord)
           join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
      from pg_index i join pg_class c on c.oid = i.indexrelid
     where c.relname = 'crm_tasks_org_external_id_unique'`);
    expect(indice).toBe("true,true,(external_id IS NOT NULL),organization_id,external_id");
    expect(
      um(`select count(*) from pg_trigger
           where tgname='zz_crm_tasks_chave_externa_ultimo' and not tgisinternal
             and tgrelid='public.crm_tasks'::regclass and tgenabled='O'`),
    ).toBe("1");
    expect(
      um(`select count(*) from pg_trigger
           where tgname='trg_crm_tasks_chave_externa' and tgrelid='public.crm_tasks'::regclass`),
    ).toBe("0");
  });

  it("⭐ o gatilho da chave é o ÚLTIMO BEFORE ROW da tabela (ordem alfabética do Postgres)", () => {
    // O limite de composição (cxj §4): outro BEFORE que ordene depois pode mudar a chave sem a
    // guarda ver. Se este caso ficar vermelho, alguém criou um — e tem de decidir, à vista.
    expect(
      um(`select coalesce(string_agg(tgname, ','), '') from pg_trigger
           where tgrelid='public.crm_tasks'::regclass and not tgisinternal
             and (tgtype & 1) = 1      -- FOR EACH ROW
             and (tgtype & 2) = 2      -- BEFORE
             and tgname > 'zz_crm_tasks_chave_externa_ultimo' collate "C"`),
    ).toBe("");
  });
});

describe("o domínio da chave: lista de caracteres, idêntica à do zod (D9 v3)", () => {
  const ok = (expr: string, n: number) =>
    erroDe(`insert into public.crm_tasks (id, organization_id, title, external_id)
            values ('${T(100 + n)}', '${ORG_A}', 'forma', ${expr});`);

  const aceitas: Array<[string, string]> = [
    ["canônica com acento pré-composto", `'contab|rotina|6249|Folha/Pró-labore|09/2026'`],
    ["canônica com Carnê-leão", `'contab|rotina|6249|Carnê-leão|11/2026'`],
    ["200 caracteres", `repeat('x', 200)`],
    ["pontuação . : - | /", `'a.b:c-d|e/f'`],
    ["as pontas do Latin-1 (À Ö Ø ö ø ÿ)", `chr(192) || chr(214) || chr(216) || chr(246) || chr(248) || chr(255)`],
  ];
  it.each(aceitas)("aceita: %s", (_nome, expr) => {
    expect(ok(expr, aceitas.findIndex((a) => a[0] === _nome))).toBeNull();
  });

  const recusadas: Array<[string, string]> = [
    ["vazia", `''`],
    ["201 caracteres", `repeat('x', 201)`],
    ["espaço ASCII no início", `' a'`],
    ["espaço ASCII no fim", `'a '`],
    ["espaço ASCII no meio (sem espaço nenhum)", `'a b'`],
    ["tabulação", `'a' || chr(9) || 'b'`],
    ["DEL", `'a' || chr(127) || 'b'`],
    ["controle C1 (NEL)", `'a' || chr(133) || 'b'`],
    ["NBSP no meio", `'a' || chr(160) || 'b'`],
    ["EM SPACE", `'a' || chr(8195) || 'b'`],
    ["LINE SEPARATOR", `'a' || chr(8232) || 'b'`],
    ["BOM", `'a' || chr(65279) || 'b'`],
    ["ZWJ", `'a' || chr(8205) || 'b'`],
    ["asterisco", `'a*b'`],
    ["aspa dupla", `'a"b'`],
    ["barra invertida", `'a\\b'`],
    ["vírgula", `'a,b'`],
    ["parênteses", `'a(b)'`],
    ["porcento, sublinhado, mais, cerquilha", `'a%b_c+d#e'`],
    ["× (U+00D7)", `'a' || chr(215) || 'b'`],
    ["÷ (U+00F7)", `'a' || chr(247) || 'b'`],
    ["NFD (ó decomposto)", `'Pro' || chr(769) || '-labore'`],
    ["dígito arábico-índico", `'a' || chr(1634) || 'b'`],
    ["dígito de largura total", `'a' || chr(65302) || 'b'`],
    ["emoji", `'a' || chr(128512)`],
    ["U+105D2 com ponto (o par do cxj)", `'k:' || chr(66002) || chr(775)`],
  ];
  it.each(recusadas)("recusa (23514): %s", (nome, expr) => {
    const erro = ok(expr, 50 + recusadas.findIndex((r) => r[0] === nome));
    expect(erro).toContain("crm_tasks_external_id_formato");
  });

  it("⭐ VARREDURA: de U+0001 a U+10FFFF, o Postgres e o zod aceitam EXATAMENTE os mesmos caracteres", () => {
    // O defeito D9v2-2 era uma regra por `normalize()`/`is nfc normalized` que divergia entre o
    // PostgreSQL 15 e o Node (20 caracteres). Agora a regra é uma lista; aqui ela é comparada
    // ponto de código a ponto de código, usando a expressão regular QUE ESTÁ NA CONSTRAINT do
    // catálogo (não a do arquivo). Surrogates (U+D800–U+DFFF) o Postgres nem representa em UTF-8:
    // a recusa do surrogate isolado é do zod e está nos testes de unidade.
    const doBanco = um(`
      with re as (
        select substring(pg_get_constraintdef(oid) from $q$~ '([^']*)'$q$) as r
          from pg_constraint
         where conname = 'crm_tasks_external_id_formato' and conrelid = 'public.crm_tasks'::regclass)
      select string_agg(n::text, ',' order by n)
        from re, generate_series(1, 1114111) n
       where (n < 55296 or n > 57343) and chr(n) ~ re.r`);
    const doZod: number[] = [];
    for (let n = 1; n <= 0x10ffff; n++) {
      if (n >= 0xd800 && n <= 0xdfff) continue;
      if (REGEX_DA_CHAVE.test(String.fromCodePoint(n))) doZod.push(n);
    }
    expect(doBanco).not.toBe("");
    expect(doBanco.split(",").map(Number)).toEqual(doZod);
    // E o tamanho do domínio é o esperado: 52 letras + 10 dígitos + 5 sinais + 62 letras Latin-1.
    expect(doZod).toHaveLength(52 + 10 + 5 + (0xff - 0xc0 + 1 - 2));
  });
});

describe("D9-1: a identidade (organization_id, external_id) não se move pela sessão", () => {
  const TAREFA_CHAVE = T(1);
  const TAREFA_SEM = T(2);
  const TAREFA_SO_A = T(3);
  beforeAll(() => {
    sql(`
      insert into public.crm_tasks (id, organization_id, title, external_id) values
        ('${TAREFA_CHAVE}', '${ORG_A}', 'do robo', 'robo:1'),
        ('${TAREFA_SO_A}', '${ORG_A}', 'do robo 3', 'robo:3')
        on conflict do nothing;
      insert into public.crm_tasks (id, organization_id, title) values
        ('${TAREFA_SEM}', '${ORG_A}', 'da tela') on conflict do nothing;
    `);
  });

  const estado = (id: string) =>
    um(
      `select organization_id || '|' || coalesce(external_id, '<nulo>') from public.crm_tasks where id='${id}'`,
    );

  it("⭐ JWT de quem está nas duas organizações NÃO move a tarefa com chave (o achado do cxj)", () => {
    const erro = erroDe(
      comoSessao(
        USER_DUAS,
        `update public.crm_tasks set organization_id='${ORG_B}' where id='${TAREFA_CHAVE}';`,
      ),
    );
    expect(erro).toContain("tarefa_chave_externa_imutavel");
    expect(estado(TAREFA_CHAVE)).toBe(`${ORG_A}|robo:1`);
  });

  it("nem com `external_id = external_id` junto (o retorno antecipado antigo deixava passar)", () => {
    const erro = erroDe(
      comoSessao(
        USER_DUAS,
        `update public.crm_tasks set organization_id='${ORG_B}', external_id=external_id where id='${TAREFA_CHAVE}';`,
      ),
    );
    expect(erro).toContain("tarefa_chave_externa_imutavel");
    expect(estado(TAREFA_CHAVE)).toBe(`${ORG_A}|robo:1`);
  });

  it("a sessão não troca nem limpa a chave posta", () => {
    for (const novo of [`'outra'`, `null`]) {
      expect(
        erroDe(
          comoSessao(
            USER_DUAS,
            `update public.crm_tasks set external_id=${novo} where id='${TAREFA_CHAVE}';`,
          ),
        ),
      ).toContain("tarefa_chave_externa_imutavel");
    }
    expect(estado(TAREFA_CHAVE)).toBe(`${ORG_A}|robo:1`);
  });

  it("a sessão não adota (não grava chave onde não havia), nem no insert", () => {
    expect(
      erroDe(
        comoSessao(
          USER_DUAS,
          `update public.crm_tasks set external_id='sequestrada' where id='${TAREFA_SEM}';`,
        ),
      ),
    ).toContain("tarefa_chave_externa_e_do_servidor");
    expect(
      erroDe(
        comoSessao(
          USER_DUAS,
          `insert into public.crm_tasks (organization_id, title, external_id) values ('${ORG_A}', 'x', 'k-sessao');`,
        ),
      ),
    ).toContain("tarefa_chave_externa_e_do_servidor");
    expect(estado(TAREFA_SEM)).toBe(`${ORG_A}|<nulo>`);
  });

  it("o service_role também não move nem troca nem limpa chave posta, mas repetir o mesmo valor passa", () => {
    expect(
      erroDe(
        comoServico(
          `update public.crm_tasks set organization_id='${ORG_B}' where id='${TAREFA_CHAVE}';`,
        ),
      ),
    ).toContain("tarefa_chave_externa_imutavel");
    expect(
      erroDe(
        comoServico(`update public.crm_tasks set external_id='outra' where id='${TAREFA_CHAVE}';`),
      ),
    ).toContain("tarefa_chave_externa_imutavel");
    expect(
      erroDe(
        comoServico(`update public.crm_tasks set external_id=null where id='${TAREFA_CHAVE}';`),
      ),
    ).toContain("tarefa_chave_externa_imutavel");
    expect(
      erroDe(
        comoServico(`update public.crm_tasks set external_id='robo:1' where id='${TAREFA_CHAVE}';`),
      ),
    ).toBeNull();
    expect(estado(TAREFA_CHAVE)).toBe(`${ORG_A}|robo:1`);
  });

  it("o service_role grava a chave onde não havia (a adoção do robô)", () => {
    expect(
      erroDe(
        comoServico(
          `update public.crm_tasks set external_id='robo:2' where id='${TAREFA_SEM}' and external_id is null;`,
        ),
      ),
    ).toBeNull();
    expect(estado(TAREFA_SEM)).toBe(`${ORG_A}|robo:2`);
  });

  it("edição normal continua: título, status e até mover tarefa SEM chave de organização", () => {
    const tarefa = T(4);
    sql(
      `insert into public.crm_tasks (id, organization_id, title) values ('${tarefa}', '${ORG_A}', 'solta') on conflict do nothing;`,
    );
    expect(
      erroDe(
        comoSessao(
          USER_DUAS,
          `update public.crm_tasks set title='renomeada', status='done' where id='${TAREFA_CHAVE}';`,
        ),
      ),
    ).toBeNull();
    expect(
      um(`select title || '|' || status from public.crm_tasks where id='${TAREFA_CHAVE}'`),
    ).toBe("renomeada|done");
    expect(
      erroDe(
        comoSessao(
          USER_DUAS,
          `update public.crm_tasks set organization_id='${ORG_B}' where id='${tarefa}';`,
        ),
      ),
    ).toBeNull();
    expect(um(`select organization_id from public.crm_tasks where id='${tarefa}'`)).toBe(ORG_B);
  });

  it("a RLS segue valendo: quem só é da A não enxerga a tarefa da B", () => {
    expect(
      um(
        comoSessao(
          USER_SO_A,
          `select count(*) from public.crm_tasks where organization_id='${ORG_B}';`,
        ),
      ),
    ).toBe("0");
    expect(TAREFA_SO_A).toBeTruthy();
  });

  it("anonimização (LGPD) segue: o título é redigido e a chave fica", () => {
    const contato = "d9d9d9d9-3333-4000-8000-000000000001";
    const tarefa = T(5);
    sql(`
      insert into public.contacts (id, organization_id, display_name) values ('${contato}', '${ORG_A}', 'Fulano D9') on conflict do nothing;
      insert into public.crm_tasks (id, organization_id, title, description, contact_id, external_id)
        values ('${tarefa}', '${ORG_A}', 'Ligar para Fulano', 'dado pessoal', '${contato}', 'robo:anon') on conflict do nothing;
      select public.fn_lgpd_cascade_redact_contact('${ORG_A}', '${contato}', gen_random_uuid());
    `);
    expect(
      um(
        `select title || '|' || coalesce(description, '<nula>') || '|' || external_id from public.crm_tasks where id='${tarefa}'`,
      ),
    ).toBe("Tarefa anonimizada|<nula>|robo:anon");
  });

  it("cascata: apagar a organização apaga as tarefas com chave, sem esbarrar na trava", () => {
    const org = "d9d9d9d9-0000-4000-8000-0000000000c1";
    sql(`
      insert into public.organizations (id, slug, legal_name, display_name) values ('${org}', 'd9-descartavel', 'D9 desc', 'D9 desc') on conflict do nothing;
      insert into public.crm_tasks (organization_id, title, external_id) values ('${org}', 'a', 'casc:1'), ('${org}', 'b', 'casc:2');
    `);
    expect(erroDe(`delete from public.organizations where id='${org}';`)).toBeNull();
    expect(um(`select count(*) from public.crm_tasks where organization_id='${org}'`)).toBe("0");
  });
});

describe("o limite de composição do gatilho (cxj §4), provado numa transação desfeita", () => {
  const tarefa = T(20);
  beforeAll(() => {
    sql(
      `insert into public.crm_tasks (id, organization_id, title, external_id) values ('${tarefa}', '${ORG_A}', 'limite', 'limite:1') on conflict do nothing;`,
    );
  });
  const gatilho = (nome: string) => `
    create function public.d9_limpa_${nome}() returns trigger language plpgsql as $f$ begin new.external_id := null; return new; end $f$;
    create trigger ${nome} before update of title on public.crm_tasks for each row execute function public.d9_limpa_${nome}();`;

  it("um BEFORE que ordena ANTES do nosso e limpa a chave é barrado (a guarda vê o NEW final)", () => {
    const erro = erroDe(`begin; ${gatilho("aaa_limpa_antes")}
      update public.crm_tasks set title='x' where id='${tarefa}'; rollback;`);
    expect(erro).toContain("tarefa_chave_externa_imutavel");
  });

  it("⚠️ LIMITE: um BEFORE que ordena DEPOIS do nosso limpa a chave sem a guarda ver — por isso o catálogo o proíbe", () => {
    expect(
      um(`begin; ${gatilho("zzz_limpa_depois")}
        update public.crm_tasks set title='x' where id='${tarefa}';
        select coalesce(external_id, '<nulo>') from public.crm_tasks where id='${tarefa}';`),
    ).toBe("<nulo>");
    // (o `begin` ficou aberto na sessão que acabou: o Postgres desfaz sozinho ao fechar.)
    expect(um(`select external_id from public.crm_tasks where id='${tarefa}'`)).toBe("limite:1");
  });
});

// D9v2-3 (cxj): o conferidor de catálogo aprovava função vazia, `WHEN (false)` e constraint permissiva.
// Agora ele compara cada objeto POR EQUIVALÊNCIA EXATA. Cada sabotagem roda numa transação desfeita
// (DDL é transacional no Postgres); o conferidor tem de FALHAR, e o banco volta intacto.
describe("o conferidor de catálogo (scripts/d9-conferir-catalogo.sql): positivo e negativos exatos", () => {
  const conferidor = readFileSync(join(__dirname, "../../scripts/d9-conferir-catalogo.sql"), "utf8");
  const sabotado = (sabotagem: string) => erroDe(`begin;\n${sabotagem}\n${conferidor}\nrollback;`);
  const GUARDA = "public.fn_crm_tasks_chave_externa_guarda";

  it("positivo: no banco recém-instalado pelo baseline, o conferidor passa", () => {
    expect(erroDe(conferidor)).toBeNull();
  });

  it("positivo: reaplicar a migration sobre o banco migrado e conferir de novo passa", () => {
    const mig = readFileSync(
      join(__dirname, "../../supabase/migrations/20261111132148_9252_tarefas_chave_externa_unica.sql"),
      "utf8",
    );
    expect(erroDe(`${mig}\n${mig}\n${conferidor}`)).toBeNull();
  });

  const negativos: Array<[string, string, string]> = [
    [
      "função vazia (nome, tipo, INVOKER e ACL iguais; corpo trocado) — sabotagem 1 do cxj",
      `create or replace function ${GUARDA}() returns trigger language plpgsql set search_path = public, pg_temp as $$ begin return new; end $$;`,
      "corpo diferente do canônico",
    ],
    [
      "gatilho com WHEN (false) (mesmo nome, função, eventos e estado) — sabotagem 2 do cxj",
      `drop trigger zz_crm_tasks_chave_externa_ultimo on public.crm_tasks;
       create trigger zz_crm_tasks_chave_externa_ultimo before insert or update on public.crm_tasks
         for each row when (false) execute function ${GUARDA}();`,
      "gatilho zz_crm_tasks_chave_externa_ultimo",
    ],
    [
      "constraint permissiva (`or external_id is not null`) VALIDADA — sabotagem 3 do cxj",
      `alter table public.crm_tasks drop constraint crm_tasks_external_id_formato;
       alter table public.crm_tasks add constraint crm_tasks_external_id_formato
         check (external_id is null or char_length(external_id) between 1 and 200 or external_id is not null);`,
      "constraint: definição diferente da canônica",
    ],
    [
      "um BEFORE ROW posterior (zzz_depois)",
      `create function public.d9_depois() returns trigger language plpgsql as $$ begin return new; end $$;
       create trigger zzz_depois before update on public.crm_tasks for each row execute function public.d9_depois();`,
      "BEFORE ROW que ordena DEPOIS da guarda",
    ],
    [
      "gatilho desligado",
      `alter table public.crm_tasks disable trigger zz_crm_tasks_chave_externa_ultimo;`,
      "gatilho zz_crm_tasks_chave_externa_ultimo",
    ],
    [
      "gatilho só `update of title` (lista de colunas)",
      `drop trigger zz_crm_tasks_chave_externa_ultimo on public.crm_tasks;
       create trigger zz_crm_tasks_chave_externa_ultimo before insert or update of title on public.crm_tasks
         for each row execute function ${GUARDA}();`,
      "gatilho zz_crm_tasks_chave_externa_ultimo",
    ],
    [
      "gatilho só INSERT",
      `drop trigger zz_crm_tasks_chave_externa_ultimo on public.crm_tasks;
       create trigger zz_crm_tasks_chave_externa_ultimo before insert on public.crm_tasks
         for each row execute function ${GUARDA}();`,
      "gatilho zz_crm_tasks_chave_externa_ultimo",
    ],
    [
      "função SECURITY DEFINER",
      `alter function ${GUARDA}() security definer;`,
      "função (nargs",
    ],
    [
      "função com search_path diferente",
      `alter function ${GUARDA}() set search_path = public;`,
      "função (nargs",
    ],
    [
      "EXECUTE da função concedido ao authenticated",
      `grant execute on function ${GUARDA}() to authenticated;`,
      "EXECUTE concedido",
    ],
    [
      "índice não único",
      `drop index public.crm_tasks_org_external_id_unique;
       create index crm_tasks_org_external_id_unique on public.crm_tasks (organization_id, external_id) where external_id is not null;`,
      "índice",
    ],
    [
      "índice sem o predicado parcial",
      `drop index public.crm_tasks_org_external_id_unique;
       create unique index crm_tasks_org_external_id_unique on public.crm_tasks (organization_id, external_id);`,
      "índice: definição diferente da canônica",
    ],
    [
      "constraint não validada",
      `alter table public.crm_tasks drop constraint crm_tasks_external_id_formato;
       alter table public.crm_tasks add constraint crm_tasks_external_id_formato
         check (external_id is null or (char_length(external_id) between 1 and 200 and external_id ~ '^[A-Za-z0-9À-ÖØ-öø-ÿ|/.:-]+$')) not valid;`,
      "validada",
    ],
    [
      "coluna com default",
      `alter table public.crm_tasks alter column external_id set default 'x';`,
      "coluna external_id",
    ],
  ];
  it.each(negativos)("negativo: %s", (_nome, sabotagem, trecho) => {
    const erro = sabotado(sabotagem);
    expect(erro, "o conferidor APROVOU uma trava sabotada").not.toBeNull();
    expect(erro).toContain("conferir-catalogo D9");
    expect(erro).toContain(trecho);
  });

  it("depois dos negativos o banco continua certo (as sabotagens foram desfeitas)", () => {
    expect(erroDe(conferidor)).toBeNull();
  });
});

describe("concorrência real: várias conexões, a mesma chave", () => {
  const psql = (script: string) =>
    execFileAsync(
      "docker",
      ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-tA", "-c", script],
      { encoding: "utf8" },
    ).then(
      (r) => ({ ok: true, texto: r.stdout + r.stderr }),
      (e: { stderr?: string }) => ({ ok: false, texto: String(e.stderr ?? e) }),
    );

  it("20 inserts simultâneos com a mesma chave: 1 grava, 19 recebem 23505 no índice certo", async () => {
    const r = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        psql(
          `insert into public.crm_tasks (organization_id, title, external_id) values ('${ORG_A}', 'massa-${i}', 'massa:1')`,
        ),
      ),
    );
    expect(r.filter((x) => x.ok)).toHaveLength(1);
    const falhas = r.filter((x) => !x.ok);
    expect(falhas).toHaveLength(19);
    for (const f of falhas) expect(f.texto).toContain("crm_tasks_org_external_id_unique");
    expect(
      um(
        `select count(*) from public.crm_tasks where organization_id='${ORG_A}' and external_id='massa:1'`,
      ),
    ).toBe("1");
  });

  it("20 adoções simultâneas da mesma tarefa com chaves diferentes: 1 `UPDATE 1`, 19 `UPDATE 0`", async () => {
    const tarefa = T(30);
    sql(
      `insert into public.crm_tasks (id, organization_id, title) values ('${tarefa}', '${ORG_A}', 'sem chave') on conflict do nothing;`,
    );
    const r = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        psql(
          `with u as (update public.crm_tasks set external_id='adotada:${i}' where id='${tarefa}' and organization_id='${ORG_A}' and external_id is null returning 1) select count(*) from u`,
        ),
      ),
    );
    const contagens = r.map((x) => x.texto.trim());
    expect(contagens.filter((c) => c === "1")).toHaveLength(1);
    expect(contagens.filter((c) => c === "0")).toHaveLength(19);
  });
});

describe("tabela com dados e reaplicação (a migração é re-aplicável e não mexe nas linhas)", () => {
  it("reaplicar 9252 com tarefas (com e sem chave) não muda uma linha nem o catálogo", () => {
    const migracao = readFileSync(
      join(
        __dirname,
        "../../supabase/migrations/20261111132148_9252_tarefas_chave_externa_unica.sql",
      ),
      "utf8",
    );
    const foto = () =>
      um(
        `select md5(string_agg(id::text || organization_id::text || title || coalesce(external_id, '<n>'), ',' order by id)) || ',' || count(*) from public.crm_tasks`,
      );
    const antes = foto();
    expect(Number(antes.split(",")[1])).toBeGreaterThan(5);
    expect(erroDe(migracao)).toBeNull();
    expect(foto()).toBe(antes);
    expect(
      um(
        `select convalidated::text from pg_constraint where conname='crm_tasks_external_id_formato'`,
      ),
    ).toBe("true");
  });
});
