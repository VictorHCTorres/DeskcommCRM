/**
 * Consumidor de `contact.tag_added`: a etiqueta `pix-pedido` num contato da
 * Linha A abre um aviso CRÍTICO na Central. Regra e texto em
 * `./pix-pedido-na-central.ts`.
 *
 * ─── Por que não é regra de automação ───────────────────────────────────────
 *
 * O gatilho existe ("Quando um contato ganhar uma tag"), mas nenhuma AÇÃO do
 * motor de automações abre item na Central: `notify_team` manda WhatsApp ao
 * número da equipe, `create_task` abre tarefa. E a ação nova precisaria ler o
 * negócio aberto do contato para escrever serviço, preço e código.
 *
 * ─── Atrás de opção, desligada por padrão ───────────────────────────────────
 *
 * Só age na organização que tem a linha `linha_a_pix_pedido_na_central`
 * (`enabled = true`) em `org_guardrail_layers`. Sem ela, todo evento sai como
 * `skipped` depois de UMA leitura por chave primária — e só para o evento que
 * traz a etiqueta `pix-pedido`; os demais nem leem o banco.
 *
 * ─── `kind = 'other'`, `ref_kind = 'lead'` ──────────────────────────────────
 *
 * A mesma escolha do aviso de etapa (`lib/leads/aviso-de-etapa.handler.ts`):
 * `other` já tem destino "Abrir negócio" na Central, e um kind novo exigiria
 * reconstruir o CHECK de `agent_inbox_items` (migration).
 */
import type { EventHandler, EventRow, HandlerResult } from "@/lib/event-log/dispatcher";
import { ETIQUETA_FUNIL_A } from "@/lib/escalacao/excecao-funil-a";
import { createAdminClient } from "@/lib/supabase/admin";

import {
  corpoDoPixPedido,
  ganhouPixPedido,
  OPCAO_PIX_PEDIDO_NA_CENTRAL,
  TITULO_DO_PIX_PEDIDO,
} from "./pix-pedido-na-central";

const CONSUMER_KEY = "linha-a.pix-pedido-na-central";

const resultado = (status: HandlerResult["status"], detail?: string): HandlerResult => ({
  consumer_key: CONSUMER_KEY,
  status,
  detail,
});

const normalizar = (texto: string): string => texto.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/gu, "");

type Admin = ReturnType<typeof createAdminClient>;

export async function tratarPixPedido(admin: Admin, row: EventRow): Promise<HandlerResult> {
  if (!ganhouPixPedido(row.payload)) return resultado("skipped", "outra_etiqueta");
  const contatoId = row.entity_id;
  if (!contatoId) return resultado("skipped", "sem_contato");
  const org = row.organization_id;

  // ⚠️ Organização em TODA leitura: o client é service-role e ignora RLS.
  const { data: opcao, error: erroDaOpcao } = await admin
    .from("org_guardrail_layers")
    .select("enabled")
    .eq("organization_id", org)
    .eq("layer", OPCAO_PIX_PEDIDO_NA_CENTRAL)
    .maybeSingle();
  if (erroDaOpcao) return resultado("error", "leitura_da_opcao_falhou");
  if ((opcao as { enabled?: unknown } | null)?.enabled !== true) return resultado("skipped", "opcao_desligada");

  const { data: contato, error: erroDoContato } = await admin
    .from("contacts")
    .select("tags")
    .eq("organization_id", org)
    .eq("id", contatoId)
    .maybeSingle();
  if (erroDoContato) return resultado("error", "leitura_do_contato_falhou");
  const etiquetas = ((contato as { tags?: unknown } | null)?.tags ?? []) as unknown[];
  if (!etiquetas.some((e) => typeof e === "string" && e.trim().toLowerCase() === ETIQUETA_FUNIL_A)) {
    return resultado("skipped", "contato_fora_da_linha_a");
  }

  const { data: negocios, error: erroDosNegocios } = await admin
    .from("crm_leads")
    .select("id, custom_fields, crm_pipelines!inner(name, slug)")
    .eq("organization_id", org)
    .eq("contact_id", contatoId)
    .eq("status", "open")
    .limit(50);
  if (erroDosNegocios) return resultado("error", "leitura_dos_negocios_falhou");
  type Negocio = { id: string; custom_fields: unknown; crm_pipelines: { name?: string | null; slug?: string | null } | Array<{ name?: string | null; slug?: string | null }> | null };
  const daProspeccao = ((negocios ?? []) as Negocio[]).filter((n) => {
    const funil = Array.isArray(n.crm_pipelines) ? n.crm_pipelines[0] : n.crm_pipelines;
    return normalizar(funil?.name ?? "") === "prospeccao" || (funil?.slug ?? "").trim().toLowerCase() === "prospeccao";
  });
  if (daProspeccao.length === 0) return resultado("skipped", "sem_negocio_da_linha_a");
  // Mais de um negócio aberto: o aviso sai assim mesmo (a pessoa aceitou e
  // alguém precisa ver), apontando para o mais recente lido e dizendo que há mais.
  const negocio = daProspeccao[0]!;
  const corpo =
    corpoDoPixPedido(negocio.custom_fields) +
    (daProspeccao.length > 1
      ? `\nAtenção: este contato tem ${daProspeccao.length} negócios abertos no funil Prospecção; confira qual é o do aceite.`
      : "");

  // Um aviso aberto por negócio: o evento reprocessado, ou a etiqueta tirada e
  // posta de novo antes de alguém resolver, não empilha itens iguais.
  const { data: jaAberto, error: erroDaBusca } = await admin
    .from("agent_inbox_items")
    .select("id")
    .eq("organization_id", org)
    .eq("kind", "other")
    .eq("ref_kind", "lead")
    .eq("ref_id", negocio.id)
    .eq("status", "open")
    .eq("title", TITULO_DO_PIX_PEDIDO)
    .limit(1);
  if (erroDaBusca) return resultado("error", "busca_de_aviso_aberto_falhou");
  if ((jaAberto ?? []).length > 0) return resultado("skipped", "aviso_ja_aberto");

  const { error: erroDoInsert } = await admin.from("agent_inbox_items").insert({
    organization_id: org,
    kind: "other",
    severity: "critical",
    title: TITULO_DO_PIX_PEDIDO,
    body: corpo,
    ref_kind: "lead",
    ref_id: negocio.id,
  });
  if (erroDoInsert) return resultado("error", "aviso_nao_entrou_na_central");
  return resultado("ok", "aviso_aberto");
}

export const pixPedidoNaCentralHandler: EventHandler = {
  key: CONSUMER_KEY,
  // Escrita interna no próprio banco, sem rede e sem falar com ninguém.
  naOrgParada: "roda",
  events: ["contact.tag_added"],
  handle: (row) => tratarPixPedido(createAdminClient(), row),
};
