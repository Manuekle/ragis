#!/bin/sh
# Crea los roles de login de la aplicación (sin BYPASSRLS). Las migraciones solo otorgan privilegios.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE ragsis_app LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '${RAGSIS_APP_DB_PASSWORD}';
CREATE ROLE ragsis_worker LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '${RAGSIS_WORKER_DB_PASSWORD}';
SQL
