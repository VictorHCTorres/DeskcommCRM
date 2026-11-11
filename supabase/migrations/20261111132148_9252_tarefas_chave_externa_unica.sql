-- manifest: `crm_tasks.external_id` — chave externa única por organização, para que quem grava tarefa por token (robôs do n8n, importador) não crie a mesma tarefa em dobro (D9).
-- 9252: coluna nula + constraint de forma + índice único parcial `crm_tasks_org_external_id_unique`.
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
-- Nula, ou de 1 a 200 caracteres, sem espaço nas pontas e sem caractere de controle
-- (U+0001–U+001F e U+007F; o U+0000 o próprio Postgres já não guarda em `text`). Nada é
-- aparado em silêncio: "a " e "a" seriam a mesma chave sem o robô saber.
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
-- ─── Reversão (se for preciso voltar)
--
--   drop index if exists public.crm_tasks_org_external_id_unique;
--   alter table public.crm_tasks drop constraint if exists crm_tasks_external_id_formato;
--   alter table public.crm_tasks drop column if exists external_id;
--
-- Aditiva: nenhuma linha existente muda (a coluna nasce nula).

alter table public.crm_tasks
  add column if not exists external_id text;

-- `not valid` + `validate`: a coluna nasce toda nula, então validar é imediato, mas o par
-- evita segurar o bloqueio mais forte sobre uma tabela já em uso se um dia houver dado.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'crm_tasks_external_id_formato'
       and conrelid = 'public.crm_tasks'::regclass
  ) then
    alter table public.crm_tasks
      add constraint crm_tasks_external_id_formato
      check (
        external_id is null
        or (
          char_length(external_id) between 1 and 200
          and external_id = btrim(external_id)
          and external_id !~ '[\x01-\x1f\x7f]'
        )
      ) not valid;
  end if;
end $$;

alter table public.crm_tasks validate constraint crm_tasks_external_id_formato;

create unique index if not exists crm_tasks_org_external_id_unique
  on public.crm_tasks (organization_id, external_id)
  where external_id is not null;

comment on column public.crm_tasks.external_id is
  'Chave externa de idempotência, única por organização (índice crm_tasks_org_external_id_unique). NULL = tarefa feita à mão. Escolhida por quem grava por token; não pôr dado pessoal nela: não é redigida na anonimização (zerá-la liberaria a chave e permitiria a tarefa em dobro).';
