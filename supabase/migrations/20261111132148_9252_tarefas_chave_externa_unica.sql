-- manifest: `crm_tasks.external_id` — chave externa única por organização, para que quem grava tarefa por token (robôs do n8n, importador) não crie a mesma tarefa em dobro (D9).
-- 9252: coluna nula + constraint de forma + índice único parcial `crm_tasks_org_external_id_unique` + trava de quem escreve a chave.
--
-- ─── Por que o banco, e não a rota
--
-- Um robô que lê "não existe" e depois grava é um TOCTOU: dois escritores no mesmo minuto
-- (agendamento, "Rodar agora", o importador) leem os dois "não existe" e gravam os dois. A
-- leitura da lista corta em 500 linhas, então uma tarefa fora do corte também parece "não
-- existir". Só um índice único fecha as duas portas: a rota apenas traduz o 23505 em 409.
--
-- ─── A forma da chave (a rota recusa com 422 antes; a constraint é o último muro)
--
-- UMA regra, idêntica no zod (`lib/tarefas/chave-externa.ts`) e aqui:
--   · de 1 a 200 pontos de código;
--   · espaço ASCII (U+0020) nas pontas: proibido (o `btrim` do Postgres só apara ele);
--   · proibidos em qualquer posição: controles C0 (U+0001–U+001F; o U+0000 o Postgres já não
--     guarda em `text`), U+007F e os controles C1 (U+0080–U+009F); os espaços Unicode (categoria
--     Zs menos o U+0020: U+00A0, U+1680, U+2000–U+200A, U+202F, U+205F, U+3000) mais U+2028,
--     U+2029 e U+FEFF; e o `*`, que o PostgREST traduz como curinga no operador LIKE do prefixo
--     (um `*` na chave faria o filtro por prefixo devolver tarefas que não têm o prefixo);
--   · a chave tem de estar em NFC (`is nfc normalized`): "ó" composto e decomposto seriam duas
--     chaves distintas para o mesmo texto, e o índice único não os reconheceria como iguais.
-- Nada é aparado nem normalizado em silêncio: quem manda a chave errada recebe 422.
-- Fica PERMITIDO o que a lista acima não nomeia: acentos em NFC, `|`, `/`, `:`, `%`, `_`, `\`
-- (o filtro por prefixo os escapa) e os caracteres invisíveis de formatação que não são espaço
-- (U+200B–U+200D, U+2060): o ZWJ é parte de emojis compostos, e proibir só uma parte deles seria
-- decisão sem lastro. Quem monta chave canônica não deve usá-los.
--
-- ─── O índice
--
-- Parcial (`where external_id is not null`): a imensa maioria das tarefas é feita à mão e não
-- tem chave, e indexar NULL só engordaria o índice (NULLs já não colidem num unique). Nome
-- próprio e estável: a rota reconhece o conflito POR ESSE NOME, e não por qualquer 23505.
-- Apagar a tarefa libera a chave (é um índice sobre a linha, não uma tabela de chaves usadas).
--
-- ─── Decisão explícita sobre a anonimização (LGPD) e a cascata
--
-- `external_id` NÃO é redigido nem zerado por `trg_redigir_tarefas_ao_anonimizar` (0210) nem
-- pela cascata de exclusão (a 0657 trata de `messages.external_id`, outra coluna, e não toca
-- `crm_tasks`). Motivo: a chave é um identificador técnico de IDEMPOTÊNCIA escolhido por quem
-- grava; zerá-la liberaria a chave e deixaria o robô recriar a tarefa anonimizada em dobro —
-- o defeito que esta migration existe para impedir. O contrato de quem grava é NÃO pôr dado
-- pessoal da pessoa física na chave (use o CNPJ/ID da obrigação, o mês, o tipo; nunca nome ou
-- telefone). A tarefa em si continua sendo redigida (título e descrição) como antes.
--
-- ─── A trava: a chave é do servidor, e uma vez posta não muda (nem muda de organização)
--
-- Sem isto, uma pessoa logada poderia pôr numa tarefa QUALQUER a chave que o robô vai precisar (o
-- POST do robô levaria 409, "adotaria" a tarefa errada e a rotina nunca nasceria), ou limpar a
-- chave de uma tarefa do robô (o robô recriaria: duplicata), ou MOVER a tarefa com chave para
-- outra organização (a identidade é `(organization_id, external_id)`: a chave some da origem e
-- ocupa o destino; achado D9-1 do cxj, provado no PostgREST real com um JWT de quem está nas duas
-- organizações). O navegador fala direto com o PostgREST, com o JWT da pessoa, e a policy de
-- update da 0210 deixa um `agent` escrever em qualquer coluna: a rota sozinha não segura nada.
-- O trigger segura nos dois caminhos, e vale para TODO update (não só `update of external_id`):
--   · `authenticated` e `anon` (a sessão e a chave pública) NÃO gravam chave onde não havia,
--     nem no insert, nem no update;
--   · se a chave antiga NÃO é nula, mudar `external_id` OU `organization_id` é exceção (42501)
--     para todos, inclusive `service_role`. Repetir o mesmo valor não é mudança. Apagar a tarefa
--     libera a chave. Quem administra o banco pode desligar o trigger na própria sessão; a API
--     nunca o faz.
-- Mecanismo: `current_user` num trigger INVOKER (o mesmo de `fn_crm_proposals_transicao_da_sessao`,
-- 0464): o PostgREST troca de papel com `SET ROLE`, então `current_user` é o papel da requisição
-- (`authenticated`/`anon`/`service_role`); função `security definer` e `postgres` não são
-- `authenticated` e passam (autoridade confiada: a trava não barra quem já é o dono do banco). Não
-- usa `auth.role()` (não existe fora de um Supabase real) nem lê claims do JWT (texto forjável).
--
-- ─── O nome do gatilho e o limite de composição (cxj §4)
--
-- O Postgres dispara os gatilhos BEFORE da mesma tabela e do mesmo evento em ordem ALFABÉTICA
-- pelo nome. O deste arquivo se chama `zz_crm_tasks_chave_externa_ultimo` de propósito: tem de
-- rodar por ÚLTIMO, para ver o NEW final e não o de antes de outro gatilho mexer nele. Limite que
-- fica de pé: um gatilho BEFORE futuro com nome que ordene DEPOIS de `zz_crm_tasks_chave_externa_ultimo`
-- (ou um `UPDATE OF <outra coluna>` que ponha `new.external_id := null`) roda depois da guarda e
-- pode mudar a chave sem ela ver. Por isso o catálogo de conferência
-- (`docs/D9-tarefas-chave-unica/conferir-catalogo.sql`) e o invariante
-- `tests/invariants/tarefas-chave-externa.test.ts` FALHAM se existir outro BEFORE ROW em
-- `crm_tasks` que ordene depois dele: quem criar um assim precisa decidir, à vista, o que fazer.
-- Anonimização (LGPD): o gatilho 0210 só mexe em `title` e `description`; a cascata de exclusão
-- apaga a linha. Nenhum dos dois toca a chave nem a organização, então seguem funcionando.
--
-- ─── Reversão (se for preciso voltar)
--
--   drop trigger if exists zz_crm_tasks_chave_externa_ultimo on public.crm_tasks;
--   drop function if exists public.fn_crm_tasks_chave_externa_guarda();
--   drop index if exists public.crm_tasks_org_external_id_unique;
--   alter table public.crm_tasks drop constraint if exists crm_tasks_external_id_formato;
--   alter table public.crm_tasks drop column if exists external_id;
--
-- Com chaves já gravadas, o DROP COLUMN apaga o mapa de idempotência: exporte antes
-- `organization_id, id, external_id` (ver docs/D9-tarefas-chave-unica/VOLTA-D9.md). A volta de
-- software NÃO exige desfazer o schema: ele é aditivo.
--
-- Aditiva: nenhuma linha existente muda (a coluna nasce nula).

alter table public.crm_tasks
  add column if not exists external_id text;

-- Reaplicação auto-curativa: a constraint é derrubada e recriada, para que um banco que recebeu
-- uma versão anterior da regra (sem Unicode, só ASCII) fique com a regra desta. `not valid` +
-- `validate`: a coluna nasce toda nula, então validar é imediato, mas o par evita segurar o
-- bloqueio mais forte sobre uma tabela já em uso se um dia houver dado (o `validate` ainda toma
-- `share update exclusive`; o `add column` e o `create index` tomam bloqueios próprios: a migração
-- não é "sem bloqueio", só curta).
alter table public.crm_tasks drop constraint if exists crm_tasks_external_id_formato;
alter table public.crm_tasks
  add constraint crm_tasks_external_id_formato
  check (
    external_id is null
    or (
      char_length(external_id) between 1 and 200
      and external_id = btrim(external_id)
      and external_id !~ '[\x01-\x1f\x7f\u0080-\u009f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff*]'
      and external_id is nfc normalized
    )
  ) not valid;
alter table public.crm_tasks validate constraint crm_tasks_external_id_formato;

create unique index if not exists crm_tasks_org_external_id_unique
  on public.crm_tasks (organization_id, external_id)
  where external_id is not null;

comment on column public.crm_tasks.external_id is
  'Chave externa de idempotência, única por organização (índice crm_tasks_org_external_id_unique). NULL = tarefa feita à mão. Escolhida por quem grava por token; não pôr dado pessoal nela: não é redigida na anonimização (zerá-la liberaria a chave e permitiria a tarefa em dobro).';

create or replace function public.fn_crm_tasks_chave_externa_guarda()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
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
$$;

-- Função de trigger não exige EXECUTE de quem dispara o comando (mesmo raciocínio da 0210).
revoke execute on function public.fn_crm_tasks_chave_externa_guarda() from public, anon, authenticated;
grant  execute on function public.fn_crm_tasks_chave_externa_guarda() to service_role;

-- O nome da versão anterior (`trg_crm_tasks_chave_externa`, `update of external_id`) sai: ordenava
-- no meio dos outros e não via os updates de outras colunas.
drop trigger if exists trg_crm_tasks_chave_externa on public.crm_tasks;
drop trigger if exists zz_crm_tasks_chave_externa_ultimo on public.crm_tasks;
create trigger zz_crm_tasks_chave_externa_ultimo
  before insert or update on public.crm_tasks
  for each row execute function public.fn_crm_tasks_chave_externa_guarda();
