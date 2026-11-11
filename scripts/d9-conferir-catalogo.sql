-- D9 — conferência do CATÁLOGO depois da migration 9252. SÓ LEITURA: nenhum DDL, nenhum DML.
--
-- Uso (no banco migrado):  psql -v ON_ERROR_STOP=1 -X -f d9-conferir-catalogo.sql
-- Sai com erro (exit 3 sob ON_ERROR_STOP) e diz QUAIS itens falharam. Cada item aprovado imprime
-- uma linha `ok:`. O cabeçalho da migration não prova nada: `create ... if not exists` aceita um
-- objeto homônimo de definição errada (cxj §7); este arquivo olha a definição.
--
-- Cópia idêntica em docs/D9-tarefas-chave-unica/conferir-catalogo.sql (a pasta do projeto).
do $$
declare
  falhas text[] := '{}';
  v text;
  r record;
begin
  -- 1. a coluna
  select data_type || '/' || is_nullable into v
    from information_schema.columns
   where table_schema = 'public' and table_name = 'crm_tasks' and column_name = 'external_id';
  if v = 'text/YES' then raise notice 'ok: coluna crm_tasks.external_id text, nula';
  else falhas := falhas || format('coluna external_id: esperado text/YES, achado %s', coalesce(v, '(ausente)')); end if;

  -- 2. a constraint, VALIDADA, com a regra inteira (tamanho, borda, proibidos, NFC)
  select convalidated::text || '|' || pg_get_constraintdef(oid) into v
    from pg_constraint
   where conname = 'crm_tasks_external_id_formato' and conrelid = 'public.crm_tasks'::regclass;
  if v is null then
    falhas := falhas || 'constraint crm_tasks_external_id_formato: ausente';
  elsif v not like 'true|%' then
    falhas := falhas || 'constraint crm_tasks_external_id_formato: NÃO validada';
  elsif strpos(v, 'char_length(external_id) >= 1') = 0 or strpos(v, 'char_length(external_id) <= 200') = 0
     or strpos(v, 'btrim(external_id)') = 0 or strpos(v, 'IS NFC NORMALIZED') = 0
     or strpos(v, '\u00a0') = 0 or strpos(v, '\u2028') = 0 or strpos(v, '\ufeff') = 0
     or strpos(v, '\u0080-\u009f') = 0 or strpos(v, '*]') = 0 then
    falhas := falhas || format('constraint crm_tasks_external_id_formato: definição diferente da regra de Unicode: %s', v);
  else raise notice 'ok: constraint crm_tasks_external_id_formato validada, com a regra de Unicode e NFC'; end if;

  -- 3. o índice: único, válido, parcial, nas duas colunas, nesta ordem
  select i.indisunique::text || ',' || i.indisvalid::text || ',' || coalesce(pg_get_expr(i.indpred, i.indrelid), '(sem predicado)')
         || ',' || (select string_agg(a.attname, ',' order by k.ord)
                      from unnest(i.indkey) with ordinality k(attnum, ord)
                      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
         || ',' || i.indrelid::regclass::text into v
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where c.relname = 'crm_tasks_org_external_id_unique';
  if v = 'true,true,(external_id IS NOT NULL),organization_id,external_id,crm_tasks' then
    raise notice 'ok: índice crm_tasks_org_external_id_unique único, válido, parcial (external_id IS NOT NULL) em (organization_id, external_id)';
  else falhas := falhas || format('índice crm_tasks_org_external_id_unique: %s', coalesce(v, '(ausente)')); end if;

  -- 3b. nenhum índice inválido sobrando em crm_tasks (um CREATE INDEX interrompido deixa um)
  select string_agg(c.relname, ',') into v
    from pg_index i join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.crm_tasks'::regclass and not i.indisvalid;
  if v is null then raise notice 'ok: nenhum índice inválido em crm_tasks';
  else falhas := falhas || format('índices inválidos em crm_tasks: %s', v); end if;

  -- 4. o gatilho: nome, BEFORE ROW, INSERT e UPDATE (de qualquer coluna), habilitado, função certa
  select format('%s|%s|%s|%s|%s', t.tgenabled, (t.tgtype & 1) = 1, (t.tgtype & 2) = 2,
                (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16 and (t.tgtype & 8) = 0 and (t.tgtype & 32) = 0,
                p.proname) into v
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.crm_tasks'::regclass and t.tgname = 'zz_crm_tasks_chave_externa_ultimo' and not t.tgisinternal;
  if v = 'O|t|t|t|fn_crm_tasks_chave_externa_guarda' then raise notice 'ok: gatilho zz_crm_tasks_chave_externa_ultimo (BEFORE ROW, INSERT e UPDATE, habilitado)';
  else falhas := falhas || format('gatilho zz_crm_tasks_chave_externa_ultimo: %s', coalesce(v, '(ausente)')); end if;

  -- 4b. nenhuma coluna na lista do UPDATE (tem de valer para TODO update)
  select t.tgattr::text into v from pg_trigger t
   where t.tgrelid = 'public.crm_tasks'::regclass and t.tgname = 'zz_crm_tasks_chave_externa_ultimo';
  if v = '' then raise notice 'ok: o gatilho não é "update of <colunas>"';
  else falhas := falhas || format('gatilho com lista de colunas (tgattr=%s): não vale para todo update', v); end if;

  -- 4c. o nome antigo saiu
  if exists (select 1 from pg_trigger where tgrelid = 'public.crm_tasks'::regclass and tgname = 'trg_crm_tasks_chave_externa') then
    falhas := falhas || 'gatilho antigo trg_crm_tasks_chave_externa ainda existe';
  else raise notice 'ok: o gatilho da versão anterior não existe'; end if;

  -- 5. a função: INVOKER (current_user é o papel da requisição), sem EXECUTE para a sessão
  select format('%s|%s|%s|%s', p.prosecdef, has_function_privilege('anon', p.oid, 'EXECUTE'),
                has_function_privilege('authenticated', p.oid, 'EXECUTE'),
                coalesce(to_regrole('service_role') is not null and has_function_privilege('service_role', p.oid, 'EXECUTE'), false)) into v
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fn_crm_tasks_chave_externa_guarda';
  if v = 'f|f|f|t' then raise notice 'ok: função fn_crm_tasks_chave_externa_guarda INVOKER, sem EXECUTE para anon/authenticated';
  else falhas := falhas || format('função fn_crm_tasks_chave_externa_guarda (secdef|anon|authenticated|service_role): %s', coalesce(v, '(ausente)')); end if;

  -- 6. o limite de composição: nenhum outro BEFORE ROW da tabela ordena DEPOIS do nosso
  select string_agg(t.tgname, ',') into v
    from pg_trigger t
   where t.tgrelid = 'public.crm_tasks'::regclass and not t.tgisinternal
     and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2
     and t.tgname::text collate "C" > 'zz_crm_tasks_chave_externa_ultimo' collate "C";
  if v is null then raise notice 'ok: nenhum BEFORE ROW depois do gatilho da chave (ele vê o NEW final)';
  else falhas := falhas || format('BEFORE ROW que roda DEPOIS da guarda e pode mudar a chave sem ela ver: %s', v); end if;

  if cardinality(falhas) > 0 then
    foreach v in array falhas loop raise warning 'FALHA: %', v; end loop;
    raise exception 'conferir-catalogo D9: % item(ns) falharam', cardinality(falhas) using errcode = 'P0001';
  end if;
  raise notice 'conferir-catalogo D9: TUDO ok';
end $$;
