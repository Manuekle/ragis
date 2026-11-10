import pg from "pg";

/** Contexto de seguridad aplicado con SET LOCAL en cada transacción (RLS). */
export interface SecurityContext {
  organizationId?: string;
  userId?: string;
  principals?: string[];
}

const PRINCIPAL_RE = /^(workspace|group|user):[0-9a-f-]{36}$/;

export type Db = pg.PoolClient;

export function createPool(connectionString?: string): pg.Pool {
  return new pg.Pool({ connectionString: connectionString || undefined, max: 20, idleTimeoutMillis: 30_000, statement_timeout: 15_000 });
}

export async function withContext<T>(pool: pg.Pool, ctx: SecurityContext, fn: (db: Db) => Promise<T>): Promise<T> {
  for (const p of ctx.principals ?? []) {
    if (!PRINCIPAL_RE.test(p)) throw new Error(`invalid principal: ${p}`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true), set_config('app.principals', $3, true)",
      [ctx.organizationId ?? "", ctx.userId ?? "", (ctx.principals ?? []).join(",")],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
