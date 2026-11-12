import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * O id da tarefa que já tem a chave NESTA organização, ou `"incerto"` se a leitura falhou ou
 * não achou ninguém (a dona pode ter sido apagada entre o insert e esta leitura: dizer 409
 * sem dona, ou 201, seria afirmar o que não sabemos). `organization_id` à mão: no ramo do
 * token o cliente é o admin e este filtro é o que segura a organização.
 */
export async function buscarDonaDaChave(
  db: SupabaseClient,
  orgId: string,
  chave: string,
): Promise<string | "incerto"> {
  const { data, error } = await db
    .from("crm_tasks")
    .select("id")
    .eq("organization_id", orgId)
    .eq("external_id", chave)
    .maybeSingle();
  const id = (data as { id?: string } | null)?.id;
  return error || !id ? "incerto" : id;
}
