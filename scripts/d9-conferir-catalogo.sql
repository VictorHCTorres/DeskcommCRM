-- conferir-catalogo D9 (v4) — SOMENTE LEITURA. Prova, depois da migration 9338, que o catálogo tem a D9 EXATA.
--
-- Uso:  psql -v ON_ERROR_STOP=1 -f conferir-catalogo.sql    (sai com erro e lista as FALHAS se algo divergir)
--
-- Por que "exato" (cxj D9v2-3): a versão anterior procurava nome, ACL e pedaços de texto, e aprovava uma
-- função vazia, um gatilho `WHEN (false)` e uma constraint com `OR external_id IS NOT NULL`. Aqui cada
-- objeto é comparado POR EQUIVALÊNCIA EXATA com a definição canônica embutida neste arquivo:
--   · função: esquema+nome, assinatura, retorno, linguagem, INVOKER, `proconfig`, volatilidade, ACL, e o
--     CORPO (`prosrc`) IDÊNTICO ao da migration, byte a byte;
--   · gatilho: `tgtype`, `tgenabled`, `tgqual` NULO (sem WHEN), sem lista de colunas, sem argumentos, não
--     diferível, `tgfoid` = a função acima, e o ÚLTIMO entre os BEFORE ROW;
--   · collation (v4, cxj D9v3-1): a coluna `external_id` TEM de ser `text COLLATE "C"` (`attcollation`) e o
--     índice TEM de usar a mesma (`indcollation`); `pg_get_indexdef` omite a collation herdada da coluna,
--     então comparar só o texto deixava passar uma coluna com collation ICU não determinística (a
--     constraint recusa INSERT válido com 0A000) e este instrumento imprimia "TUDO ok";
--   · constraint: tipo, validada e `pg_get_constraintdef` IGUAL ao texto canônico (a regra inteira);
--   · índice: `pg_get_indexdef` IGUAL ao texto canônico, único, válido, pronto, vivo, predicado.
-- O texto canônico de `pg_get_constraintdef`/`pg_get_indexdef` foi medido no PostgreSQL 15.19 (o baseline
-- real) e conferido igual no 17.11 (sonda com a mesma constraint); outra versão maior que imprima diferente
-- FALHA aqui e pede que se registre a impressão — nunca se aprova por substring.
-- Negativos provados em tests/invariants/tarefas-chave-externa.test.ts (função vazia, WHEN (false),
-- constraint permissiva, gatilho posterior, gatilho desligado, search_path, SECURITY DEFINER, índice).
do $conferir$
declare
  falhas text[] := '{}';
  v text;
  n int;
  oid_fn oid;
  esp_corpo constant text := $fn$
begin
  if tg_op = 'UPDATE' and old.external_id is not null then
    -- A identidade da tarefa já identificada: nem a chave nem a organização mudam, para ninguém.
    if new.external_id is distinct from old.external_id
       or new.organization_id is distinct from old.organization_id then
      raise exception 'tarefa_chave_externa_imutavel' using errcode = '42501';
    end if;
    return new;
  end if;
  -- Daqui: INSERT, ou UPDATE de tarefa sem chave. Pôr chave onde não havia é do servidor.
  if new.external_id is not null and current_user in ('authenticated', 'anon') then
    raise exception 'tarefa_chave_externa_e_do_servidor' using errcode = '42501';
  end if;
  return new;
end;
$fn$;
  esp_constraint constant text := $ck$CHECK (((external_id IS NULL) OR (((char_length(external_id) >= 1) AND (char_length(external_id) <= 200)) AND (external_id ~ '^[A-Za-z0-9\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u00ff|/.:-]+$'::text))))$ck$;
  esp_indice constant text := $ix$CREATE UNIQUE INDEX crm_tasks_org_external_id_unique ON public.crm_tasks USING btree (organization_id, external_id) WHERE (external_id IS NOT NULL)$ix$;
begin
  -- 1. a coluna
  select format('%s|%s|%s|%s|%s', a.atttypid::regtype, a.attnotnull, a.atthasdef, a.attgenerated, a.attidentity) into v
    from pg_attribute a
   where a.attrelid = 'public.crm_tasks'::regclass and a.attname = 'external_id' and not a.attisdropped;
  if v = 'text|f|f||' then raise notice 'ok: coluna crm_tasks.external_id text, anulável, sem default';
  else falhas := falhas || format('coluna external_id: %s', coalesce(v, '(ausente)')); end if;

  -- 1b. a COLLATION efetiva da coluna: "C" (pg_catalog), a única que dá igualdade por byte e aceita regex
  select n.nspname || '.' || c.collname into v
    from pg_attribute a
    join pg_collation c on c.oid = a.attcollation
    join pg_namespace n on n.oid = c.collnamespace
   where a.attrelid = 'public.crm_tasks'::regclass and a.attname = 'external_id' and not a.attisdropped;
  if v = 'pg_catalog.C' then raise notice 'ok: a collation da coluna external_id é pg_catalog."C"';
  else falhas := falhas || format('collation da coluna external_id: %s (esperado pg_catalog.C)', coalesce(v, '(ausente)')); end if;

  -- 2. a constraint: tipo check, validada, e a definição IGUAL à canônica (a regra inteira)
  select format('%s|%s', c.contype, c.convalidated) into v
    from pg_constraint c
   where c.conrelid = 'public.crm_tasks'::regclass and c.conname = 'crm_tasks_external_id_formato';
  if v = 'c|t' then raise notice 'ok: constraint crm_tasks_external_id_formato é check e está validada';
  else falhas := falhas || format('constraint crm_tasks_external_id_formato (tipo|validada): %s', coalesce(v, '(ausente)')); end if;
  select pg_get_constraintdef(c.oid) into v
    from pg_constraint c
   where c.conrelid = 'public.crm_tasks'::regclass and c.conname = 'crm_tasks_external_id_formato';
  if v is not distinct from esp_constraint then raise notice 'ok: a definição da constraint é a canônica';
  else falhas := falhas || format('constraint: definição diferente da canônica. obtida: %s', coalesce(v, '(ausente)')); end if;

  -- 3. o índice: definição canônica, único, válido, pronto, vivo
  select format('%s|%s|%s|%s', i.indisunique, i.indisvalid, i.indisready, i.indislive) into v
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'crm_tasks_org_external_id_unique' and i.indrelid = 'public.crm_tasks'::regclass;
  if v = 't|t|t|t' then raise notice 'ok: índice único, válido, pronto e vivo';
  else falhas := falhas || format('índice crm_tasks_org_external_id_unique (único|válido|pronto|vivo): %s', coalesce(v, '(ausente)')); end if;
  -- 3b. a collation do ÍNDICE por coluna (organization_id uuid = 0; external_id = "C"): o texto do
  -- `pg_get_indexdef` não mostra a herdada da coluna, então a prova é o `indcollation`.
  select i.indcollation::text into v
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'crm_tasks_org_external_id_unique' and i.indrelid = 'public.crm_tasks'::regclass;
  if v = '0 ' || 'pg_catalog."C"'::regcollation::oid::text then raise notice 'ok: o índice usa a collation "C" em external_id';
  else falhas := falhas || format('collation do índice crm_tasks_org_external_id_unique (indcollation): %s (esperado 0 %s = "C")', coalesce(v, '(ausente)'), 'pg_catalog."C"'::regcollation::oid::text); end if;
  select pg_get_indexdef(c.oid) into v from pg_class c
   where c.relname = 'crm_tasks_org_external_id_unique' and c.relnamespace = 'public'::regnamespace;
  if v is not distinct from esp_indice then raise notice 'ok: a definição do índice é a canônica';
  else falhas := falhas || format('índice: definição diferente da canônica. obtida: %s', coalesce(v, '(ausente)')); end if;
  select count(*) into n from pg_index i where i.indrelid = 'public.crm_tasks'::regclass and not i.indisvalid;
  if n = 0 then raise notice 'ok: nenhum índice inválido em crm_tasks';
  else falhas := falhas || format('%s índice(s) inválido(s) em crm_tasks', n); end if;

  -- 4. a função: identidade, atributos, ACL e CORPO igual ao canônico
  select p.oid into oid_fn
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'fn_crm_tasks_chave_externa_guarda';
  select format('%s|%s|%s|%s|%s|%s|%s|%s|%s', p.pronargs, pg_get_function_identity_arguments(p.oid), p.prorettype::regtype,
                (select l.lanname from pg_language l where l.oid = p.prolang), p.prosecdef, coalesce(p.proconfig::text, '(nulo)'),
                p.provolatile, p.proleakproof, p.proretset) into v
    from pg_proc p where p.oid = oid_fn;
  if v = '0||trigger|plpgsql|f|{"search_path=public, pg_temp"}|v|f|f' then
    raise notice 'ok: função fn_crm_tasks_chave_externa_guarda(): trigger, plpgsql, INVOKER, search_path fixo, VOLATILE';
  else falhas := falhas || format('função (nargs|args|retorno|linguagem|secdef|proconfig|volatilidade|leakproof|retset): %s', coalesce(v, '(ausente)')); end if;
  select p.prosrc into v from pg_proc p where p.oid = oid_fn;
  if v is not distinct from esp_corpo then raise notice 'ok: o corpo da função é o canônico (byte a byte)';
  else falhas := falhas || format('função: corpo diferente do canônico (md5 obtido %s, esperado %s)', md5(coalesce(v, '')), md5(esp_corpo)); end if;
  -- ACL: ninguém além do dono e do service_role executa (nem PUBLIC, nem anon, nem authenticated)
  select string_agg(coalesce(nullif(a.grantee, 0)::regrole::text, 'PUBLIC'), ',' order by 1) into v
    from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
   where p.oid = oid_fn and a.grantee <> p.proowner;
  if v is not distinct from 'service_role' then raise notice 'ok: EXECUTE só para o dono e o service_role';
  else falhas := falhas || format('função: EXECUTE concedido a %s (esperado: só service_role além do dono)', coalesce(v, '(ninguém)')); end if;

  -- 5. o gatilho: nome, tipo, estado, sem WHEN, sem colunas, função certa
  select format('%s|%s|%s|%s|%s|%s|%s|%s|%s|%s', t.tgtype, t.tgenabled, coalesce(t.tgqual::text, '(sem when)'),
                coalesce(t.tgattr::text, ''), t.tgnargs, t.tgdeferrable, t.tginitdeferred, coalesce(t.tgconstraint, 0),
                (t.tgfoid = oid_fn), coalesce(t.tgoldtable, '') || coalesce(t.tgnewtable, '')) into v
    from pg_trigger t
   where t.tgrelid = 'public.crm_tasks'::regclass and t.tgname = 'zz_crm_tasks_chave_externa_ultimo' and not t.tgisinternal;
  -- tgtype 23 = ROW(1) + BEFORE(2) + INSERT(4) + UPDATE(16)
  if v = '23|O|(sem when)||0|f|f|0|t|' then raise notice 'ok: gatilho zz_crm_tasks_chave_externa_ultimo: BEFORE INSERT OR UPDATE FOR EACH ROW, habilitado, sem WHEN, sem lista de colunas, função certa';
  else falhas := falhas || format('gatilho zz_crm_tasks_chave_externa_ultimo (tgtype|enabled|when|colunas|nargs|diferível|inicial|constraint|função certa|tabelas): %s', coalesce(v, '(ausente)')); end if;
  if exists (select 1 from pg_trigger where tgrelid = 'public.crm_tasks'::regclass and tgname = 'trg_crm_tasks_chave_externa') then
    falhas := falhas || 'gatilho antigo trg_crm_tasks_chave_externa ainda existe';
  else raise notice 'ok: o gatilho da versão anterior não existe'; end if;
  select count(*) into n from pg_trigger t
   where t.tgrelid = 'public.crm_tasks'::regclass and t.tgfoid = oid_fn and not t.tgisinternal;
  if n = 1 then raise notice 'ok: a função é chamada por um gatilho só';
  else falhas := falhas || format('a função é chamada por %s gatilhos (esperado 1)', n); end if;

  -- 6. o limite de composição: nenhum outro BEFORE ROW da tabela ordena DEPOIS do nosso
  select string_agg(t.tgname, ',') into v
    from pg_trigger t
   where t.tgrelid = 'public.crm_tasks'::regclass and not t.tgisinternal
     and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2
     and t.tgname collate "C" > 'zz_crm_tasks_chave_externa_ultimo';
  if v is null then raise notice 'ok: nenhum BEFORE ROW depois do gatilho da chave (ele vê o NEW final)';
  else falhas := falhas || format('BEFORE ROW que ordena DEPOIS da guarda e pode mexer na chave sem ela ver: %s', v); end if;

  if cardinality(falhas) > 0 then
    foreach v in array falhas loop raise warning 'FALHA: %', v; end loop;
    raise exception 'conferir-catalogo D9: % item(ns) falharam', cardinality(falhas);
  end if;
  raise notice 'conferir-catalogo D9: TUDO ok';
end
$conferir$;
