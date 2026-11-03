import type { SupabaseClient } from "@supabase/supabase-js";

export type VereditoDosVinculos = "ok" | "fora_da_organizacao" | "falha_na_consulta";

/** Confere as duas FKs cujo id sozinho não prova pertencimento ao tenant. */
export async function conferirVinculosDaTarefa(
  db: SupabaseClient,
  organizationId: string,
  vinculos: { lead_id?: string | null; contact_id?: string | null },
): Promise<VereditoDosVinculos> {
  const consultas = [
    vinculos.lead_id
      ? db
          .from("crm_leads")
          .select("id")
          .eq("id", vinculos.lead_id)
          .eq("organization_id", organizationId)
          .maybeSingle()
      : null,
    vinculos.contact_id
      ? db
          .from("contacts")
          .select("id")
          .eq("id", vinculos.contact_id)
          .eq("organization_id", organizationId)
          .maybeSingle()
      : null,
  ].filter((consulta): consulta is Exclude<typeof consulta, null> => consulta !== null);
  const respostas = await Promise.all(consultas);
  if (respostas.some(({ error }) => error)) return "falha_na_consulta";
  if (respostas.some(({ data }) => !data)) return "fora_da_organizacao";
  return "ok";
}
