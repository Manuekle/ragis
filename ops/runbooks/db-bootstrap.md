# Bootstrap de base de datos (AWS)

1. Obtener credenciales maestras de RDS desde Secrets Manager (`master_secret_arn` del módulo `database`).
2. Desde un bastion/SSM Session Manager dentro de la VPC (la BD no es pública):
   ```sql
   CREATE ROLE ragsis_app LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '<RAGSIS_APP_DB_PASSWORD>';
   CREATE ROLE ragsis_worker LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '<RAGSIS_WORKER_DB_PASSWORD>';
   ```
   Las contraseñas están en el secreto `<env>/app` creado por el módulo `security`.
3. Ejecutar migraciones con el rol propietario (tarea ECS one-off con la imagen `api`):
   `node dist/db/migrate.js` con `DATABASE_URL` del propietario y `MIGRATIONS_DIR=/app/db/migrations`.
4. Verificar: `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'ragsis_%';` → `f` en ambos.
5. Ejecutar `uv run pytest tests/python/test_isolation.py` contra staging antes del primer cliente.

Migraciones: siempre forward-compatible (agregar columnas nullable, backfill, luego restringir).
