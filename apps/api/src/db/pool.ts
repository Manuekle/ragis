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
  const pool = new pg.Pool({ connectionString: connectionString || undefined, max: 20, idleTimeoutMillis: 30_000, statement_timeout: 15_000 });
  // pg emite `error` en el pool cuando se cae una conexión INACTIVA (reinicio de Postgres, corte de red, Docker en
  // suspensión). Sin listener Node lo trata como excepción no capturada y mata la API. El pool descarta ese cliente
  // y abre otro en la próxima consulta.
  pool.on("error", (err) => {
    console.error(JSON.stringify({ level: 40, msg: "conexión inactiva de Postgres descartada", err: err.message }));
  });
  return pool;
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
