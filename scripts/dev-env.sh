#!/bin/sh
# Genera .env local con secretos aleatorios. Nunca reutilizar fuera de desarrollo.
set -eu
[ -f .env ] && { echo ".env ya existe"; exit 0; }
r() { openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-40; }
cat > .env <<ENV
POSTGRES_PASSWORD=$(r)
RAGSIS_APP_DB_PASSWORD=$(r)
RAGSIS_WORKER_DB_PASSWORD=$(r)
INTERNAL_SERVICE_SECRET=$(r)$(r)
JWT_DEV_SECRET=$(r)$(r)
AUTH_MODE=dev
AI_DEFAULT_PROVIDER=local
ENV
echo ".env generado"
