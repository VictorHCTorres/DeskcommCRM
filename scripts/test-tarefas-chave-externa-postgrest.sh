#!/usr/bin/env bash
# test-tarefas-chave-externa-postgrest.sh — o gate REPRODUZÍVEL da chave externa das tarefas (D9).
#
# Prova, contra Postgres + PostgREST de verdade (nada de dublê de banco):
#   1. UPGRADE COM DADOS: um banco instalado pelo baseline da base (1.101.0, D9_BASE_REF) com
#      centenas de tarefas é atualizado pelo baseline da branch (que carrega a 9252) DUAS vezes,
#      com ON_ERROR_STOP=1; o hash das linhas antigas não muda, a coluna nasce nula.
#   2. CATÁLOGO: scripts/d9-conferir-catalogo.sql (somente leitura) passa nesse banco e no instalado do zero.
#   3. A SUÍTE REAL (tests/d9-real): handlers de produção + supabase-js + PostgREST v13 sobre o baseline
#      inteiro (RLS, trigger, índice): POST 201/409, outro 23505, dona ausente, PATCH concorrente,
#      count/embed/RLS/cortada, caracteres especiais, Unicode, D9-1 com JWT de duas organizações.
#
# Contêineres e rede têm nome único (PID + aleatório) e são removidos por trap, mesmo em erro.
# Nenhum caminho fixo em /tmp. Requisito: Docker. Não toca em nenhum outro contêiner.
#
# Uso:  bash scripts/test-tarefas-chave-externa-postgrest.sh
#       D9_BASE_REF=587fbbe81 TEST_DB_IMAGE=pgvector/pgvector:pg15 D9_POSTGREST_IMAGE=postgrest/postgrest:v13.0.7 \
#       D9_CHAVES_CANONICAS_JSONL=<operacoes-F2.jsonl> bash scripts/test-tarefas-chave-externa-postgrest.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/supabase/baseline.sql"
IMAGE="${TEST_DB_IMAGE:-pgvector/pgvector:pg15}"
PGRST_IMAGE="${D9_POSTGREST_IMAGE:-postgrest/postgrest:v13.0.7}"
BASE_REF="${D9_BASE_REF:-587fbbe81}"
SUF="$$-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
REDE="d9-rede-$SUF"
PG_VELHO="d9-pg-upgrade-$SUF"
PG_NOVO="d9-pg-real-$SUF"
REST="d9-postgrest-$SUF"
SEGREDO="d9-segredo-de-teste-com-mais-de-32-caracteres-$SUF"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/d9-gate.XXXXXX")"

[ -f "$BASELINE" ] || { echo "FATAL: $BASELINE não encontrado" >&2; exit 1; }

cleanup() {
  docker rm -fv "$REST" "$PG_NOVO" "$PG_VELHO" >/dev/null 2>&1 || true
  docker network rm "$REDE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "==> versões"
docker --version
echo "    imagem do banco: $IMAGE  ($(docker image inspect "$IMAGE" --format '{{.Id}}' | cut -c1-19))"
echo "    imagem do PostgREST: $PGRST_IMAGE  ($(docker image inspect "$PGRST_IMAGE" --format '{{.Id}}' | cut -c1-19))"
echo "    base: $BASE_REF  branch: $(git -C "$ROOT" rev-parse --short HEAD)"

docker network create "$REDE" >/dev/null

sobe_pg() { # nome
  docker run -d --rm --name "$1" --network "$REDE" -p "127.0.0.1::5432" \
    --label "deskcomm.harness=d9-chave-externa" \
    -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=postgres "$IMAGE" >/dev/null
  for _ in $(seq 1 90); do
    docker exec "$1" psql -h 127.0.0.1 -U postgres -d postgres -tAc 'select 1' >/dev/null 2>&1 && return 0
    sleep 1
  done
  echo "FATAL: postgres $1 não subiu em 90s" >&2; exit 1
}
psql_de() { docker exec -i "$1" psql -U postgres -d postgres -q -v ON_ERROR_STOP=1 -f -; }
psql_t() { docker exec -i "$1" psql -U postgres -d postgres -tA -v ON_ERROR_STOP=1 -f -; }

prelude=$(awk -v marco="psql_install <<'SQL'" '$0 == marco { captura=1; next } captura && $0 == "SQL" { exit } captura { print }' "$ROOT/scripts/test-db.sh")
if [ "$(grep -c 'create extension' <<<"$prelude")" -lt 3 ]; then
  echo "FATAL: a extração do prelude de scripts/test-db.sh falhou" >&2; exit 1
fi

# ───────────────────────── 1. UPGRADE COM DADOS ─────────────────────────
echo "==> [1] upgrade com dados: baseline de $BASE_REF  ->  baseline da branch (x2)"
git -C "$ROOT" show "$BASE_REF:supabase/baseline.sql" > "$TMP/baseline-base.sql"
if git -C "$ROOT" show "$BASE_REF:supabase/baseline.sql" | grep -q 'crm_tasks_org_external_id_unique'; then
  echo "FATAL: o baseline de $BASE_REF já tem a chave; D9_BASE_REF errado" >&2; exit 1
fi
sobe_pg "$PG_VELHO"
psql_de "$PG_VELHO" <<<"$prelude"
psql_de "$PG_VELHO" < "$TMP/baseline-base.sql" >/dev/null
echo "    ✓ base instalada"
psql_de "$PG_VELHO" <<'SQL' >/dev/null
insert into auth.users (id, email) values ('d9b00000-0000-4000-8000-000000000001', 'u@upgrade.test') on conflict do nothing;
insert into public.organizations (id, slug, legal_name, display_name) values
  ('d9b00000-0000-4000-8000-00000000000a', 'up-a', 'Up A', 'A'), ('d9b00000-0000-4000-8000-00000000000b', 'up-b', 'Up B', 'B')
  on conflict do nothing;
insert into public.crm_tasks (organization_id, title, description, status)
  select 'd9b00000-0000-4000-8000-00000000000a', 'antiga ' || g, 'chave: contab|rotina|6249|DAS|09/2026 #' || g, 'pending' from generate_series(1, 514) g;
insert into public.crm_tasks (organization_id, title, status)
  select 'd9b00000-0000-4000-8000-00000000000b', 'antiga-b ' || g, 'done' from generate_series(1, 20) g;
SQL
hash_antes=$(psql_t "$PG_VELHO" <<<"select md5(string_agg(t::text, '|' order by id)) from (select id, organization_id, title, description, status from public.crm_tasks) t;")
echo "    ✓ semeadas $(psql_t "$PG_VELHO" <<<'select count(*) from public.crm_tasks;') tarefas; hash das linhas: $hash_antes"
echo "    (o catálogo NÃO pode passar antes do update — prova que o instrumento enxerga a ausência)"
if psql_de "$PG_VELHO" < "$ROOT/scripts/d9-conferir-catalogo.sql" >/dev/null 2>&1; then
  echo "FATAL: o conferir-catalogo passou num banco SEM a migration" >&2; exit 1
fi
echo "    ✓ catálogo reprova o banco antigo"
for passada in 1 2; do
  psql_de "$PG_VELHO" < "$BASELINE" >/dev/null
  echo "    ✓ update $passada/2 com ON_ERROR_STOP=1"
done
hash_depois=$(psql_t "$PG_VELHO" <<<"select md5(string_agg(t::text, '|' order by id)) from (select id, organization_id, title, description, status from public.crm_tasks) t;")
[ "$hash_antes" = "$hash_depois" ] || { echo "FATAL: as linhas antigas mudaram no update" >&2; exit 1; }
nulas=$(psql_t "$PG_VELHO" <<<'select count(*) from public.crm_tasks where external_id is not null;')
[ "$nulas" = 0 ] || { echo "FATAL: external_id deveria nascer nulo em todas ($nulas)" >&2; exit 1; }
psql_de "$PG_VELHO" < "$ROOT/scripts/d9-conferir-catalogo.sql" >/dev/null
echo "    ✓ hash das linhas antigas idêntico; external_id nulo em todas; catálogo confere"
# A migration sozinha, de novo, sobre o banco já migrado e com dados (é o que o `supabase db push` faria).
mig=$(ls "$ROOT"/supabase/migrations/*_9252_tarefas_chave_externa_unica.sql)
psql_de "$PG_VELHO" < "$mig" >/dev/null
psql_de "$PG_VELHO" < "$mig" >/dev/null
psql_de "$PG_VELHO" < "$ROOT/scripts/d9-conferir-catalogo.sql" >/dev/null
echo "    ✓ a migration aplicada sozinha, 2x, sobre dados: sem erro, catálogo confere"
docker rm -fv "$PG_VELHO" >/dev/null

# ───────────────────────── 2. SUÍTE REAL ─────────────────────────
echo "==> [2] banco novo (baseline da branch) + PostgREST + suíte real"
sobe_pg "$PG_NOVO"
psql_de "$PG_NOVO" <<<"$prelude"
psql_de "$PG_NOVO" < "$BASELINE" >/dev/null
psql_de "$PG_NOVO" < "$ROOT/scripts/d9-conferir-catalogo.sql" >/dev/null
echo "    ✓ instalado do zero; catálogo confere"
psql_de "$PG_NOVO" <<'SQL'
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'authenticator';
  end if;
end $$;
grant anon, authenticated, service_role to authenticator;
SQL
docker run -d --rm --name "$REST" --network "$REDE" -p "127.0.0.1::3000" \
  --label "deskcomm.harness=d9-chave-externa" \
  -e "PGRST_DB_URI=postgres://authenticator:authenticator@$PG_NOVO:5432/postgres" \
  -e PGRST_DB_SCHEMAS=public -e PGRST_DB_ANON_ROLE=anon \
  -e "PGRST_JWT_SECRET=$SEGREDO" "$PGRST_IMAGE" >/dev/null
PORTA=$(docker port "$REST" 3000/tcp | head -1 | sed 's/.*://')
URL="http://127.0.0.1:$PORTA"
pronto=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$URL/"; then pronto=1; break; fi
  sleep 1
done
[ "$pronto" = 1 ] || { echo "FATAL: PostgREST não respondeu" >&2; docker logs "$REST" | tail -20 >&2; exit 1; }
echo "    ✓ PostgREST no ar: $(docker inspect "$REST" --format '{{.Config.Image}}') em $URL"

CANON=""
if [ -n "${D9_CHAVES_CANONICAS_JSONL:-}" ] && [ -f "$D9_CHAVES_CANONICAS_JSONL" ]; then
  python3 -I - "$D9_CHAVES_CANONICAS_JSONL" "$TMP/chaves.json" <<'PY'
import json, sys
chaves = sorted({json.loads(l)["chave"] for l in open(sys.argv[1], encoding="utf-8") if l.strip() and json.loads(l).get("chave")})
json.dump(chaves, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
print(f"    chaves canônicas lidas: {len(chaves)}")
PY
  CANON="$TMP/chaves.json"
fi

cd "$ROOT"
D9_PG_CONTAINER="$PG_NOVO" D9_POSTGREST_URL="$URL" D9_JWT_SECRET="$SEGREDO" D9_CHAVES_CANONICAS="$CANON" \
  npx vitest run --config vitest.d9-real.config.ts

# ───────────────────────── 3. A VOLTA (1.101.0 sobre o banco migrado) ─────────────────────────
# D9_BASE_WORKTREE: worktree (limpo) do commit da base, com node_modules. Sem ele o passo é pulado e dito.
if [ -n "${D9_BASE_WORKTREE:-}" ] && [ -d "$D9_BASE_WORKTREE" ]; then
  echo "==> [3] volta: o app da base ($(git -C "$D9_BASE_WORKTREE" rev-parse --short HEAD)) sobre o banco migrado"
  mkdir -p "$D9_BASE_WORKTREE/tests/d9-volta"
  cp "$ROOT/tests/d9-volta/volta-1101.real.ts" "$D9_BASE_WORKTREE/tests/d9-volta/"
  cp "$ROOT/vitest.d9-volta.config.ts" "$D9_BASE_WORKTREE/"
  (cd "$D9_BASE_WORKTREE" && D9_PG_CONTAINER="$PG_NOVO" D9_POSTGREST_URL="$URL" D9_JWT_SECRET="$SEGREDO" \
    npx vitest run --config vitest.d9-volta.config.ts)
else
  echo "==> [3] volta: PULADO (defina D9_BASE_WORKTREE com um worktree da base para provar o rollback)"
fi
echo "==> GATE D9 VERDE"
