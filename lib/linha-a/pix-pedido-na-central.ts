/**
 * LINHA A — o pedido de Pix vira aviso crítico na Central (1.110.2).
 *
 * No aceite, a agente da Linha A põe a etiqueta `pix-pedido` no contato e segue
 * conversando: quem gera a cobrança é uma pessoa, no Asaas, com a referência
 * `funilA:<codigo>`. Sem um aviso, o aceite — a venda mais quente — fica à
 * espera de alguém abrir a conversa por acaso.
 *
 * Este módulo é a parte PURA: a condição e o texto. O consumidor do evento está
 * em `./pix-pedido-na-central.handler.ts`.
 *
 * O que o aviso NÃO faz, de propósito: não transfere a conversa, não cala a IA,
 * não move o negócio de etapa e não manda mensagem a ninguém. É uma linha em
 * `agent_inbox_items` e nada mais.
 *
 * O corpo não leva nome nem telefone: só serviço, preço, código e a referência —
 * dados do negócio, não da pessoa. Quem abre o aviso vê o resto no negócio, com
 * a permissão que tem.
 */

/** A opção, DESLIGADA por padrão: linha em `org_guardrail_layers` (vocabulário aberto, sem migration). */
export const OPCAO_PIX_PEDIDO_NA_CENTRAL = "linha_a_pix_pedido_na_central";

/** A etiqueta que a agente põe no contato quando a pessoa aceita. */
export const ETIQUETA_PIX_PEDIDO = "pix-pedido";

export const TITULO_DO_PIX_PEDIDO = "Linha A: gerar o Pix no Asaas";

const campo = (campos: unknown, chave: string): string | null => {
  if (typeof campos !== "object" || campos === null || Array.isArray(campos)) return null;
  const v = (campos as Record<string, unknown>)[chave];
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return typeof v === "string" && v.trim() !== "" ? v.trim().replace(/\s+/gu, " ").slice(0, 120) : null;
};

/** O evento traz a etiqueta `pix-pedido` entre as ACRESCENTADAS? */
export function ganhouPixPedido(payload: Record<string, unknown> | null | undefined): boolean {
  const adicionadas = payload?.added_tags;
  return Array.isArray(adicionadas)
    && adicionadas.some((t) => typeof t === "string" && t.trim().toLowerCase() === ETIQUETA_PIX_PEDIDO);
}

/** O corpo do aviso, a partir dos campos do negócio. Campo vazio aparece como "(vazio)" — é sinal para conferir antes de cobrar. */
export function corpoDoPixPedido(campos: unknown): string {
  const servico = campo(campos, "servico") ?? "(vazio)";
  const preco = campo(campos, "preco") ?? "(vazio)";
  const codigo = campo(campos, "codigo");
  return [
    "A pessoa aceitou a oferta e espera o Pix nesta conversa.",
    `Serviço: ${servico}`,
    `Preço: ${preco}`,
    `Código: ${codigo ?? "(vazio)"}`,
    `Referência do Pix: ${codigo === null ? "(negócio sem código: conferir antes de cobrar)" : `funilA:${codigo}`}`,
    "Gere a cobrança no Asaas com essa referência e envie pela conversa. A agente continua respondendo; a conversa não foi transferida.",
  ].join("\n");
}
