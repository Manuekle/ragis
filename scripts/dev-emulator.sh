#!/usr/bin/env bash
# Local con login como en producción: Cognito de AWS Emulator + api y web en el host (docs/guides/aws-emulator.md).
#
#   scripts/dev-emulator.sh setup   # emulador, user pool y cliente (Terraform del piloto), usuarios, .env.emulator
#   scripts/dev-emulator.sh start   # para api/web de Docker y arranca los de esta máquina (logs en .emulator-run/)
#   scripts/dev-emulator.sh stop    # para api/web del host y devuelve api/web a Docker (login de desarrollo)
#
# Por qué api y web van en el host: el emulador firma los tokens con issuer https://127.0.0.1:9297/<pool>.
# Dentro de un contenedor 127.0.0.1 es el propio contenedor, así que no podría validarlos.
# Postgres, rag-engine, worker, S3 (SeaweedFS) y SQS (ElasticMQ) siguen en Docker (docs/environments.md).
#
# Variables: DEV_EMAILS (correos a crear en Cognito, separados por espacio; por defecto los de la base local).
set -euo pipefail

ACTION="${1:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
RUN="$ROOT/.emulator-run"
ENVF="$ROOT/.env.emulator"
PORT="${EMULATOR_PORT:-9297}"
DC=(docker compose -f infra/docker/compose.yml -f infra/docker/compose.emulator.yml --env-file .env)

get() { grep -E "^$1=" "$2" | head -1 | cut -d= -f2-; }

case "$ACTION" in
  setup)
    [ -f .env ] || ./scripts/dev-env.sh
    ./scripts/aws-emulator.sh up
    # El mismo user pool y cliente que el piloto, aplicados en el emulador.
    REHEARSAL_TARGETS="aws_cognito_user_pool.pilot aws_cognito_user_pool_client.web aws_cognito_user_pool_domain.pilot" \
      ./scripts/aws-rehearsal.sh apply >/dev/null
    OUT="$(./scripts/aws-rehearsal.sh output)"
    POOL="$(python3 -c 'import json,sys; print(json.loads(sys.stdin.read())["user_pool_id"]["value"])' <<<"$OUT")"
    # shellcheck disable=SC1090
    eval "$(./scripts/aws-emulator.sh env)"
    # El output "runtime" de Terraform no sirve en el emulador (trae un client id y un pool que no existen): se lee del emulador.
    CLIENT="$(aws cognito-idp list-user-pool-clients --user-pool-id "$POOL" --query 'UserPoolClients[0].ClientId' --output text)"
    PASS="${DEV_PASSWORD:-$(openssl rand -base64 24 | tr -d '/+=\n' | cut -c1-18)Aa1!}"
    EMAILS="${DEV_EMAILS:-$(docker exec ragsis-postgres-1 psql -U ragsis_owner -d ragsis -Atc 'select distinct email from users order by email' 2>/dev/null | tr '\n' ' ')}"
    [ -n "$EMAILS" ] || EMAILS="prueba@ragsis.test lector@ragsis.test"
    for e in $EMAILS; do
      aws cognito-idp admin-create-user --user-pool-id "$POOL" --username "$e" \
        --user-attributes "Name=email,Value=$e" "Name=email_verified,Value=true" --message-action SUPPRESS >/dev/null 2>&1 || true
      aws cognito-idp admin-set-user-password --user-pool-id "$POOL" --username "$e" --password "$PASS" --permanent
      echo "Cuenta Cognito (emulador): $e"
      # Vincula la identidad de Cognito a la fila existente del usuario (con sus membresías). Sin esto, el primer login
      # crearía un usuario nuevo sin organizaciones. Reutiliza la fila con membresías cuya identidad sea 'dev' o de un
      # emulador anterior; no toca identidades de otros proveedores.
      SUB="$(aws cognito-idp admin-get-user --user-pool-id "$POOL" --username "$e" --query "UserAttributes[?Name=='sub'].Value" --output text)"
      docker exec -i ragsis-postgres-1 psql -q -U ragsis_owner -d ragsis -v ON_ERROR_STOP=1 \
        -v email="$e" -v idp="https://127.0.0.1:$PORT/$POOL" -v sub="$SUB" >/dev/null <<'SQL'
BEGIN;
WITH cand AS (
  SELECT u.id FROM users u
  WHERE u.email = lower(:'email')
    AND (u.identity_provider = 'dev' OR u.identity_provider LIKE 'https://127.0.0.1:%')
    AND NOT EXISTS (SELECT 1 FROM users x WHERE x.identity_provider = :'idp' AND x.external_subject = :'sub'
                    AND EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = x.id))
  ORDER BY (SELECT count(*) FROM memberships m WHERE m.user_id = u.id) DESC, u.created_at
  LIMIT 1
), gone AS (
  -- Fila vacía creada por un login anterior con la misma identidad nueva: se quita para poder reasignarla.
  DELETE FROM users d
  WHERE d.identity_provider = :'idp' AND d.external_subject = :'sub'
    AND EXISTS (SELECT 1 FROM cand) AND d.id NOT IN (SELECT id FROM cand)
    AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = d.id)
)
UPDATE users SET identity_provider = :'idp', external_subject = :'sub' WHERE id IN (SELECT id FROM cand);
COMMIT;
SQL
    done
    set -a; . ./.env; set +a
    umask 077
    cat > "$ENVF" <<EOF
# Generado por scripts/dev-emulator.sh setup. Se pierde con el emulador (vive en memoria): repetir setup tras reiniciarlo.
AUTH_MODE=oidc
OIDC_ISSUER=https://127.0.0.1:$PORT/$POOL
OIDC_AUDIENCE=$CLIENT
OIDC_CLIENT_ID=$CLIENT
COGNITO_PASSWORD_LOGIN=true
SESSION_COOKIE_SECURE=false
PUBLIC_BASE_URL=http://localhost:3000
NODE_EXTRA_CA_CERTS=$HOME/.aws/emulator/$PORT/ca.pem
DEV_LOGIN_PASSWORD=$PASS
EOF
    echo "Escrito $ENVF (contraseña de prueba dentro; no se imprime)."
    echo "Siguiente: scripts/dev-emulator.sh start"
    ;;
  start)
    [ -f "$ENVF" ] || { echo "Falta $ENVF: corre primero setup." >&2; exit 1; }
    ./scripts/aws-emulator.sh status
    mkdir -p "$RUN"
    "${DC[@]}" stop api web >/dev/null 2>&1 || true
    "${DC[@]}" up -d --wait --no-deps rag-engine
    set -a; . ./.env; . "$ENVF"; set +a
    export DATABASE_URL="postgres://ragsis_app:${RAGSIS_APP_DB_PASSWORD}@127.0.0.1:${POSTGRES_HOST_PORT:-55432}/ragsis"
    export RAG_ENGINE_URL=http://127.0.0.1:8080
    export CORS_ORIGINS=http://localhost:3000
    export AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY:-ragsis-dev-access}" AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY:-ragsis-dev-secret-change-me}"
    export S3_ENDPOINT=http://localhost:8333 S3_PUBLIC_ENDPOINT=http://localhost:8333 S3_BUCKET=ragsis-documents
    export SQS_ENDPOINT=http://localhost:9324 SQS_INGEST_QUEUE_URL=http://localhost:9324/000000000000/ragsis-ingest
    export API_URL=http://127.0.0.1:4000 PORT=4000 RAGSIS_ENV=local
    (cd apps/api && nohup pnpm dev >"$RUN/api.log" 2>&1 </dev/null & echo $! >"$RUN/api.pid")
    for _ in $(seq 60); do curl -fsS -m 2 http://127.0.0.1:4000/healthz >/dev/null 2>&1 && break; sleep 1; done
    curl -fsS -m 2 http://127.0.0.1:4000/healthz >/dev/null || { echo "La api no arrancó; mira $RUN/api.log" >&2; exit 1; }
    (cd apps/web && PORT=3000 nohup pnpm dev >"$RUN/web.log" 2>&1 </dev/null & echo $! >"$RUN/web.pid")
    echo "API http://localhost:4000 · Web http://localhost:3000/login (Cognito del emulador). Logs: $RUN/"
    ;;
  stop)
    for s in web api; do
      [ -f "$RUN/$s.pid" ] && { pkill -P "$(cat "$RUN/$s.pid")" 2>/dev/null || true; kill "$(cat "$RUN/$s.pid")" 2>/dev/null || true; rm -f "$RUN/$s.pid"; }
    done
    "${DC[@]}" up -d --no-deps api web
    echo "api y web vuelven a Docker con login de desarrollo."
    ;;
  *) echo "Uso: $0 {setup|start|stop}" >&2; exit 2 ;;
esac
