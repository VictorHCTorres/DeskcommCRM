-- manifest: Fecha ACL interna do sidecar ClickUp e impede que uma fila de retenção apague um anexo cujo caminho voltou a ter referência viva.

-- As cinco tabelas são envelope interno. O service_role usa RPCs para as
-- transições e não precisa de DELETE direto; as policies `using (false)` não
-- acrescentam proteção (service_role ignora RLS) e ainda viram policy ALL
-- sem régua de papel no inventário de RBAC.
drop policy if exists clickup_comment_receipts_service_only on public.clickup_comment_receipts;
drop policy if exists clickup_asset_sidecars_service_only on public.clickup_asset_sidecars;
drop policy if exists clickup_asset_uploads_service_only on public.clickup_asset_uploads;
drop policy if exists clickup_asset_items_service_only on public.clickup_asset_items;
drop policy if exists clickup_asset_receipts_service_only on public.clickup_asset_receipts;

revoke delete on table public.clickup_comment_receipts from public, anon, authenticated, service_role;
revoke delete on table public.clickup_asset_sidecars from public, anon, authenticated, service_role;
revoke delete on table public.clickup_asset_uploads from public, anon, authenticated, service_role;
revoke delete on table public.clickup_asset_items from public, anon, authenticated, service_role;
revoke delete on table public.clickup_asset_receipts from public, anon, authenticated, service_role;

-- Funções de trigger SECURITY DEFINER não são RPCs. O grant padrão do
-- Supabase as tornava chamáveis diretamente por qualquer sessão autenticada.
revoke execute on function public.fn_guard_clickup_attachment_quota()
  from public, anon, authenticated;
revoke execute on function public.fn_queue_clickup_asset_delete()
  from public, anon, authenticated;
grant execute on function public.fn_guard_clickup_attachment_quota() to service_role;
grant execute on function public.fn_queue_clickup_asset_delete() to service_role;

-- Defesa forward-safe para bancos em que uma reaplicação antiga do bloco
-- 0731 tenha removido a constraint. Não substitui a forma ampliada da 9097.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.crm_lead_attachments'::regclass
       and conname = 'crm_lead_attachments_storage_path_check'
  ) then
    alter table public.crm_lead_attachments
      add constraint crm_lead_attachments_storage_path_check check (
        case
          when source_attachment_id is null then
            field_key ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'
            and storage_path ~ (
              '^' || organization_id::text || '/leads/' || lead_id::text || '/' || field_key ||
              '/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
            )
          else
            storage_path ~ (
              '^' || organization_id::text || '/[A-Za-z0-9._-]+/leads/' || lead_id::text ||
              '/[0-9a-f]{64}\\.[a-z0-9]+$'
            )
        end
      );
  end if;
end $$;

-- DELETE enfileira o blob para retenção. Se o mesmo caminho volta a ter
-- uma referência antes do worker, a fila sem request LGPD deixa de representar
-- um órfão e precisa sair. Pedidos LGPD nunca são cancelados por este gatilho.
create or replace function public.fn_cancel_clickup_asset_delete_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_bucket text;
begin
  v_bucket := case
    when tg_table_name = 'crm_lead_attachments' and new.source_attachment_id is null
      then 'internal-media'
    else 'clickup-assets'
  end;

  delete from public.storage_redaction_queue
   where bucket = v_bucket
     and object_path = new.storage_path
     and request_id is null;
  return new;
end;
$$;

revoke execute on function public.fn_cancel_clickup_asset_delete_on_insert()
  from public, anon, authenticated;
grant execute on function public.fn_cancel_clickup_asset_delete_on_insert() to service_role;

drop trigger if exists trg_clickup_lead_attachment_revive on public.crm_lead_attachments;
create trigger trg_clickup_lead_attachment_revive
  after insert on public.crm_lead_attachments for each row
  execute function public.fn_cancel_clickup_asset_delete_on_insert();
drop trigger if exists trg_clickup_task_attachment_revive on public.crm_task_attachments;
create trigger trg_clickup_task_attachment_revive
  after insert on public.crm_task_attachments for each row
  execute function public.fn_cancel_clickup_asset_delete_on_insert();
drop trigger if exists trg_clickup_knowledge_attachment_revive on public.ai_knowledge_source_attachments;
create trigger trg_clickup_knowledge_attachment_revive
  after insert on public.ai_knowledge_source_attachments for each row
  execute function public.fn_cancel_clickup_asset_delete_on_insert();
