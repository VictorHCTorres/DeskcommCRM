#!/usr/bin/env bash
# test-tarefas-chave-externa-postgrest.sh — o gate REPRODUZÍVEL da chave externa das tarefas (D9).
#
# Prova, contra Postgres + PostgREST de verdade (nada de dublê de banco):
#   1. UPGRADE COM DADOS: um banco instalado pelo baseline da base (1.101.0, D9_BASE_REF) com
#      centenas de tarefas é atualizado pelo baseline da branch (que carrega a 8338) DUAS vezes,
#      com ON_ERROR_STOP=1; o hash das linhas antigas não muda, a coluna nasce nula.
#   2. CATÁLOGO: scripts/d9-conferir-catalogo.sql (somente leitura) passa nesse banco e no instalado do zero.
#   2b. CURA DA v3 (v4, D9v3-1): um banco que recebeu a D9 v3 (coluna `external_id` SEM a collation "C") com
#      chaves gravadas é atualizado pelo baseline da branch (x2): a coluna vira `COLLATE "C"`, as linhas e
#      as chaves não mudam, o catálogo confere.
#   3. A SUÍTE REAL (tests/d9-real): handlers de produção + supabase-js + PostgREST v13 sobre o baseline
#      inteiro (RLS, trigger, índice): POST 201/409, outro 23505, dona ausente, PATCH concorrente,
#      count/embed/RLS/cortada, caracteres especiais, Unicode, D9-1 com JWT de duas organizações.
#
# Contêineres e rede têm nome único (PID + aleatório) e são removidos por trap, mesmo em erro.
# Nenhum caminho fixo em /tmp. Requisito: Docker. Não toca em nenhum outro contêiner.
#
# DOIS veredictos, que nunca se confundem:
#   · "GATE D9 DA API VERDE (volta NÃO provada)": os passos 1 e 2 (upgrade, catálogo, suíte real);
#   · "GATE D9 COMPLETO VERDE": os passos 1, 2 e 3 (a volta: o app de D9_BASE_REF sobre o banco migrado).
# Sem D9_PULAR_VOLTA=1 a volta roda; com ele o script diz que pulou e NUNCA imprime o veredicto completo.
# A base é verificada (D9_BASE_REF tem de resolver para o commit 587fbbe81…) e NUNCA é escrita: a árvore
# dela é extraída por `git archive` para um diretório temporário.
#
# Pré-requisitos: docker (daemon rodando), git, awk, curl, tar, python3 (só com D9_CHAVES_CANONICAS_JSONL),
# node/npx e as dependências do repositório instaladas (node_modules). Nenhuma credencial, nenhuma rede além
# do pull das imagens (se ainda não estiverem locais).
#
# Uso:  bash scripts/test-tarefas-chave-externa-postgrest.sh
#       D9_BASE_REF=587fbbe81 TEST_DB_IMAGE=pgvector/pgvector:pg15 D9_POSTGREST_IMAGE=postgrest/postgrest:v13.0.7 \
#       D9_CHAVES_CANONICAS_JSONL=<operacoes-F2.jsonl> D9_AMOSTRAS_JSON=<chaves-amostras.json> bash scripts/test-tarefas-chave-externa-postgrest.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASELINE="$ROOT/supabase/baseline.sql"
IMAGE="${TEST_DB_IMAGE:-pgvector/pgvector:pg15}"
PGRST_IMAGE="${D9_POSTGREST_IMAGE:-postgrest/postgrest:v13.0.7}"
BASE_REF="${D9_BASE_REF:-587fbbe81}"
V3_REF="${D9_V3_REF:-4c9e44efb1025577f40d298af78ed3fe23cd1596}"   # a D9 v3 (a que o cxj reprovou): coluna sem COLLATE "C"
BASE_ESPERADA="587fbbe81a3fdd1202cf9033cb4e0e7d94251450"   # a 1.101.0 DO FORK (a tag homônima do upstream é outro commit)
SUF="$$-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n')"
REDE="d9-rede-$SUF"
PG_VELHO="d9-pg-upgrade-$SUF"
PG_V3="d9-pg-v3-$SUF"
PG_NOVO="d9-pg-real-$SUF"
REST="d9-postgrest-$SUF"
SEGREDO="d9-segredo-de-teste-com-mais-de-32-caracteres-$SUF"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/d9-gate.XXXXXX")"

[ -f "$BASELINE" ] || { echo "FATAL: $BASELINE não encontrado" >&2; exit 1; }

cleanup() {
  docker rm -fv "$REST" "$PG_NOVO" "$PG_VELHO" "$PG_V3" >/dev/null 2>&1 || true
  docker network rm "$REDE" >/dev/null 2>&1 || true
  # O diretório temporário é nosso (mktemp acima); só se apaga um caminho com o nome que ele gerou.
  case "$TMP" in "${TMPDIR:-/tmp}"/d9-gate.*) find "$TMP" -depth -delete 2>/dev/null || true ;; esac
}
trap cleanup EXIT

echo "==> pré-requisitos"
faltam=""
for c in docker git awk curl tar npx; do command -v "$c" >/dev/null 2>&1 || faltam="$faltam $c"; done
[ -z "${D9_CHAVES_CANONICAS_JSONL:-}" ] || command -v python3 >/dev/null 2>&1 || faltam="$faltam python3"
[ -d "$ROOT/node_modules" ] || faltam="$faltam node_modules(pnpm install)"
docker info >/dev/null 2>&1 || faltam="$faltam docker(daemon parado)"
[ -z "$faltam" ] || { echo "FATAL: faltam:$faltam" >&2; exit 1; }
BASE_SHA=$(git -C "$ROOT" rev-parse --verify "$BASE_REF^{commit}")
[ "$BASE_SHA" = "$BASE_ESPERADA" ] || { echo "FATAL: D9_BASE_REF=$BASE_REF resolve para $BASE_SHA, não para a 1.101.0 do fork ($BASE_ESPERADA)" >&2; exit 1; }
echo "    ok; base $BASE_SHA; node $(node --version)"

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
mig=$(ls "$ROOT"/supabase/migrations/*_8338_tarefas_chave_externa_unica.sql)
psql_de "$PG_VELHO" < "$mig" >/dev/null
psql_de "$PG_VELHO" < "$mig" >/dev/null
psql_de "$PG_VELHO" < "$ROOT/scripts/d9-conferir-catalogo.sql" >/dev/null
echo "    ✓ a migration aplicada sozinha, 2x, sobre dados: sem erro, catálogo confere"
docker rm -fv "$PG_VELHO" >/dev/null

# ───────────────────────── 1b. CURA DA v3 ─────────────────────────
echo "==> [1b] cura da v3: baseline de ${V3_REF:0:9} (coluna sem COLLATE \"C\")  ->  baseline da branch (x2)"
if git -C "$ROOT" cat-file -e "$V3_REF^{commit}" 2>/dev/null; then
  git -C "$ROOT" show "$V3_REF:supabase/baseline.sql" > "$TMP/baseline-v3.sql"
  grep -q 'crm_tasks_org_external_id_unique' "$TMP/baseline-v3.sql" || { echo "FATAL: o baseline de $V3_REF não tem a D9" >&2; exit 1; }
  grep -q 'external_id text collate "C"' "$TMP/baseline-v3.sql" && { echo "FATAL: o baseline de $V3_REF já tem COLLATE C; D9_V3_REF errado" >&2; exit 1; }
  sobe_pg "$PG_V3"
  psql_de "$PG_V3" <<<"$prelude"
  psql_de "$PG_V3" < "$TMP/baseline-v3.sql" >/dev/null
  col_antes=$(psql_t "$PG_V3" <<<"select n.nspname || '.' || c.collname from pg_attribute a join pg_collation c on c.oid = a.attcollation join pg_namespace n on n.oid = c.collnamespace where a.attrelid = 'public.crm_tasks'::regclass and a.attname = 'external_id';")
  [ "$col_antes" != "pg_catalog.C" ] || { echo "FATAL: a v3 já está em C; a cura não seria provada" >&2; exit 1; }
  psql_de "$PG_V3" <<'SQL' >/dev/null
insert into auth.users (id, email) values ('d9c00000-0000-4000-8000-000000000001', 'u@v3.test') on conflict do nothing;
insert into public.organizations (id, slug, legal_name, display_name) values
  ('d9c00000-0000-4000-8000-00000000000a', 'v3-a', 'V3 A', 'A') on conflict do nothing;
insert into public.crm_tasks (organization_id, title, status, external_id)
  select 'd9c00000-0000-4000-8000-00000000000a', 'v3 ' || g, 'pending', 'contab|rotina|6249|Folha/Pró-labore|' || g from generate_series(1, 300) g;
insert into public.crm_tasks (organization_id, title, status, external_id) values
  ('d9c00000-0000-4000-8000-00000000000a', 'v3 maiúscula', 'pending', 'Chave:A'),
  ('d9c00000-0000-4000-8000-00000000000a', 'v3 minúscula', 'pending', 'Chave:a'),
  ('d9c00000-0000-4000-8000-00000000000a', 'v3 sem chave', 'pending', null);
SQL
  hv3_antes=$(psql_t "$PG_V3" <<<"select md5(string_agg(t::text, '|' order by id)) from (select id, organization_id, title, status, external_id from public.crm_tasks) t;")
  for passada in 1 2; do
    psql_de "$PG_V3" < "$BASELINE" >/dev/null
    echo "    ✓ update $passada/2 sobre a v3 com ON_ERROR_STOP=1"
  done
  hv3_depois=$(psql_t "$PG_V3" <<<"select md5(string_agg(t::text, '|' order by id)) from (select id, organization_id, title, status, external_id from public.crm_tasks) t;")
  [ "$hv3_antes" = "$hv3_depois" ] || { echo "FATAL: a cura da v3 mudou linhas ou chaves" >&2; exit 1; }
  col_depois=$(psql_t "$PG_V3" <<<"select n.nspname || '.' || c.collname from pg_attribute a join pg_collation c on c.oid = a.attcollation join pg_namespace n on n.oid = c.collnamespace where a.attrelid = 'public.crm_tasks'::regclass and a.attname = 'external_id';")
  [ "$col_depois" = "pg_catalog.C" ] || { echo "FATAL: depois da cura a collation é $col_depois, não pg_catalog.C" >&2; exit 1; }
  psql_de "$PG_V3" < "$ROOT/scripts/d9-conferir-catalogo.sql" >/dev/null
  echo "    ✓ collation $col_antes -> $col_depois; linhas e chaves idênticas (hash $hv3_depois); catálogo confere"
  docker rm -fv "$PG_V3" >/dev/null
else
  echo "FATAL: o commit da v3 ($V3_REF) não existe neste clone; a cura da v3 NÃO foi provada (D9_V3_REF=<commit> ou D9_PULAR_CURA_V3=1)" >&2
  [ "${D9_PULAR_CURA_V3:-0}" = 1 ] || exit 1
fi

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

if [ -z "${D9_AMOSTRAS_JSON:-}" ]; then
  echo "    AVISO: D9_AMOSTRAS_JSON não informado: os exemplos de limite_get de chaves-amostras.json NÃO foram conferidos contra a rota"
fi
cd "$ROOT"
D9_PG_CONTAINER="$PG_NOVO" D9_POSTGREST_URL="$URL" D9_JWT_SECRET="$SEGREDO" D9_CHAVES_CANONICAS="$CANON" \
  D9_AMOSTRAS_JSON="${D9_AMOSTRAS_JSON:-}" npx vitest run --config vitest.d9-real.config.ts

# ───────────────────────── 3. A VOLTA (o app da base sobre o banco migrado) ─────────────────────────
VOLTA="nao"
if [ "${D9_PULAR_VOLTA:-0}" = 1 ]; then
  echo "==> [3] volta: PULADA por D9_PULAR_VOLTA=1 — a volta NÃO foi provada"
else
  echo "==> [3] volta: o app de $BASE_SHA sobre o banco migrado"
  # A base é extraída para um temporário (git archive): nunca se escreve numa árvore de verdade.
  mkdir -p "$TMP/base"
  git -C "$ROOT" archive "$BASE_SHA" | tar -x -C "$TMP/base"
  ln -s "$ROOT/node_modules" "$TMP/base/node_modules"
  mkdir -p "$TMP/base/tests/d9-volta"
  cp "$ROOT/tests/d9-volta/volta-1101.real.ts" "$TMP/base/tests/d9-volta/"
  cp "$ROOT/vitest.d9-volta.config.ts" "$TMP/base/"
  # Prova de que o que roda é mesmo a base: o baseline extraído NÃO tem a chave e é idêntico ao do commit.
  if grep -q crm_tasks_org_external_id_unique "$TMP/base/supabase/baseline.sql"; then
    echo "FATAL: a árvore extraída da base já tem a chave" >&2; exit 1
  fi
  (cd "$TMP/base" && D9_PG_CONTAINER="$PG_NOVO" D9_POSTGREST_URL="$URL" D9_JWT_SECRET="$SEGREDO" \
    npx vitest run --config vitest.d9-volta.config.ts)
  VOLTA="sim"
fi

if [ "$VOLTA" = "sim" ]; then
  echo "==> GATE D9 COMPLETO VERDE (API + volta)"
else
  echo "==> GATE D9 DA API VERDE (volta NÃO provada: não é o gate completo)"
fi
