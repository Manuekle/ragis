# Database bootstrap (AWS)

1. Get the RDS master credentials from Secrets Manager (`master_secret_arn` of the `database` module).
2. From a bastion/SSM Session Manager inside the VPC (the DB is not public):
   ```sql
   CREATE ROLE ragsis_app LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '<RAGSIS_APP_DB_PASSWORD>';
   CREATE ROLE ragsis_worker LOGIN NOBYPASSRLS NOSUPERUSER PASSWORD '<RAGSIS_WORKER_DB_PASSWORD>';
   ```
   The passwords are in the `<env>/app` secret created by the `security` module.
3. Run migrations with the owner role (one-off ECS task with the `api` image):
   `node dist/db/migrate.js` with the owner's `DATABASE_URL` and `MIGRATIONS_DIR=/app/db/migrations`.
4. Verify: `SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname LIKE 'ragsis_%';` → `f` on both.
5. Run `uv run pytest tests/python/test_isolation.py` against staging before the first customer.

Migrations: always forward-compatible (add nullable columns, backfill, then constrain).
