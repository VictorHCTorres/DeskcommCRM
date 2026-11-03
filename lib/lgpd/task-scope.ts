/** Escopo único usado tanto na cópia quanto na anonimização do titular. */
export function filtroDeTarefasDoTitular(contactId: string, leadIds: readonly string[]) {
  const unicos = [...new Set(leadIds)];
  if (unicos.length === 0) return `contact_id.eq.${contactId}`;
  const leads = unicos.map((id) => `"${id}"`).join(",");
  return `contact_id.eq.${contactId},lead_id.in.(${leads})`;
}
