import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { webhookFormFieldsSchema, type WebhookFormField } from "@/lib/webhooks/formulario";

export const CAMPO_ANTISPAM_FORMULARIO_PUBLICO = "__deskcomm_site";

const tokenDoFormularioSchema = z.string().trim().min(8).max(255);

export interface FormularioPublico {
  nome: string;
  token: string;
  campos: WebhookFormField[];
}

/**
 * A presença da chave reservada identifica o cliente nativo mesmo quando o
 * honeypot está vazio. Esta verificação precisa acontecer antes da limpeza do
 * payload; integrações genéricas não ganham validações novas por acidente.
 */
export function ehSubmissaoFormularioPublico(payload: Record<string, unknown>): boolean {
  return Object.prototype.hasOwnProperty.call(payload, CAMPO_ANTISPAM_FORMULARIO_PUBLICO);
}

function textoPreenchido(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Defesa server-side do contrato que o navegador já apresenta ao usuário. */
export function submissaoFormularioPublicoEhValida(
  payload: Record<string, unknown>,
  campos: readonly WebhookFormField[],
): boolean {
  if (!textoPreenchido(payload.nome) || !textoPreenchido(payload.telefone)) return false;

  return campos.every((campo) => {
    if (!campo.required) return true;
    const valor = payload[campo.key];
    if (campo.type === "checkbox") return valor === true || valor === "true";
    return textoPreenchido(valor) || (typeof valor === "number" && Number.isFinite(valor));
  });
}

/**
 * Resolve somente o contrato público do formulário.
 *
 * A organização vem da linha encontrada pelo token e nunca é devolvida ao
 * navegador. Fonte pausada ou protegida por HMAC não tem formulário público:
 * nos dois casos a resposta é a mesma (404), sem revelar qual condição falhou.
 */
export async function buscarFormularioPublico(
  token: string,
  admin: SupabaseClient = createAdminClient(),
): Promise<FormularioPublico | null> {
  const tokenValido = tokenDoFormularioSchema.safeParse(token);
  if (!tokenValido.success) return null;

  const { data, error } = await admin
    .from("webhook_sources")
    .select("name, path_token, form_fields, is_active, secret_encrypted")
    .eq("path_token", tokenValido.data)
    .maybeSingle();

  if (error) {
    logger.error("[formulario-publico] não foi possível resolver a fonte", {
      errorCode: error.code,
      errorMessage: error.message,
    });
    throw new Error("Não foi possível carregar o formulário.");
  }
  if (!data || data.is_active !== true || data.secret_encrypted) return null;

  const campos = webhookFormFieldsSchema.safeParse(data.form_fields ?? []);
  if (!campos.success) {
    logger.error("[formulario-publico] a fonte tem perguntas inválidas", {
      issues: campos.error.issues.map((issue) => ({ path: issue.path, code: issue.code })),
    });
    return null;
  }

  return {
    nome: typeof data.name === "string" && data.name.trim() ? data.name.trim() : "Formulário",
    token: tokenValido.data,
    campos: campos.data,
  };
}

/**
 * O campo começa com `__`, prefixo que o editor já reserva. Assim nenhuma
 * pergunta legítima pode colidir com o honeypot.
 */
export function filtrarHoneypotFormularioPublico(payload: Record<string, unknown>): {
  bloqueado: boolean;
  payload: Record<string, unknown>;
} {
  const { [CAMPO_ANTISPAM_FORMULARIO_PUBLICO]: armadilha, ...limpo } = payload;
  const bloqueado =
    typeof armadilha === "string"
      ? armadilha.trim().length > 0
      : armadilha !== undefined && armadilha !== null;
  return { bloqueado, payload: limpo };
}
