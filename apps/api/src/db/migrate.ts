/**
 * Migrador SQL (mismo contrato que packages/ragsis-core/src/ragsis_core/migrate.py).
 * Ejecutar con el rol propietario del esquema, nunca con ragsis_app.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

export async function migrate(databaseUrl: string, dir: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('ragsis:migrations'))");
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const version = f.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      await client.query(await readFile(path.join(dir, f), "utf8"));
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      applied.push(version);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await client.end();
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  const dir = process.env.MIGRATIONS_DIR ?? path.resolve(process.cwd(), "../../db/migrations");
  if (!url) {
    console.error("DATABASE_URL requerido");
    process.exit(1);
  }
  migrate(url, dir)
    .then((v) => {
      console.log(v.length ? `applied: ${v.join(", ")}` : "schema up to date");
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
