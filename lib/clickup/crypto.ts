import { createHmac } from "node:crypto";

import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";

export interface ClickUpEncryptedToken {
  token_ciphertext: string;
  token_iv: string;
  token_tag: string;
  token_last4: string;
}

/** Cifra o token sem criar uma segunda chave/implementação criptográfica. */
export function encryptClickUpToken(token: string): ClickUpEncryptedToken {
  const encrypted = encryptKey(token);
  return {
    token_ciphertext: bufToBytea(encrypted.ciphertext),
    token_iv: bufToBytea(encrypted.iv),
    token_tag: bufToBytea(encrypted.tag),
    token_last4: encrypted.last4,
  };
}

export function decryptClickUpToken(row: {
  token_ciphertext: unknown;
  token_iv: unknown;
  token_tag: unknown;
}): string {
  return decryptKey({
    ciphertext: byteaToBuffer(row.token_ciphertext),
    iv: byteaToBuffer(row.token_iv),
    tag: byteaToBuffer(row.token_tag),
  });
}

/**
 * Identidade opaca do token para vincular um Idempotency-Key ao mesmo pedido.
 * O HMAC impede que o request_hash persistido funcione como oráculo de tokens.
 */
export function fingerprintClickUpTokenForIdempotency(
  token: string,
  secret = process.env.INTERNAL_SECRET?.trim(),
): string {
  if (!secret) {
    throw new Error("INTERNAL_SECRET ausente: idempotência da conexão ClickUp indisponível");
  }
  return createHmac("sha256", secret).update(`clickup-connection-token:v1:${token}`).digest("hex");
}
