import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Config da VOLTA (1.101.0 sobre o banco migrado). Roda DENTRO do worktree da base, com o teste
 * `tests/d9-volta/volta-1101.real.ts` copiado para lá pelo gate (o arquivo é só do gate; o código
 * sob teste é o da base). Ver `scripts/test-tarefas-chave-externa-postgrest.sh`.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/d9-volta/**/*.real.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-a-placeholder-1234567890-1234567890",
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
