import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Config do gate da chave externa das tarefas contra PostgREST de verdade
 * (`scripts/test-tarefas-chave-externa-postgrest.sh`). Fica FORA da suíte normal: os arquivos
 * são `*.real.ts` (o `vitest.config.ts` só pega `*.test.ts`) e precisam de um Postgres + PostgREST
 * que só o script sobe.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/d9-real/**/*.real.ts"],
    globals: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
    fileParallelism: false,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-role-key-not-a-placeholder-1234567890-1234567890",
    },
  },
  resolve: { alias: { "@": path.resolve(__dirname, ".") } },
});
