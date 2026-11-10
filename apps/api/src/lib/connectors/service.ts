/**
 * Orquestación de conectores (CON-01, ADR-025): registro de proveedores, OAuth, tokens cifrados y planificador.
 *
 * El planificador corre dentro de la API (como el envío de invitaciones de firma): cada minuto toma conectores
 * vencidos con app.due_connectors(), adquiere un lease en BD (seguro con varias réplicas) y sincroniza por pasadas
 * acotadas (tiempo y nº de cambios) guardando el cursor. Los errores se traducen a estados que la UI explica.
 */
import { createHash, randomBytes } from "node:crypto";
import type { Deps } from "../../app.js";
import { withContext, type Db } from "../../db/pool.js";
import type { Plan } from "../tenant.js";
import { clickup } from "./clickup.js";
import { TokenCipher } from "./crypto.js";
import { createFakeWorld, fakeFetch, seedDemoWorld, type FakeWorld } from "./fake-apis.js";
import { gmail } from "./gmail.js";
import { ProviderError, providerHttp } from "./http.js";
import { ConnectorSink, QuotaError, connectorContext, tombstoneDocuments, type ConnectorRow } from "./sink.js";
import { slack } from "./slack.js";
import type { Fetch, OAuthClient, ProviderAdapter, ProviderHttp, ProviderId, TokenSet } from "./types.js";

export const ADAPTERS: Record<ProviderId, ProviderAdapter<any>> = { gmail, slack, clickup };

export interface FullConnectorRow extends ConnectorRow {
  settings: Record<string, unknown>;
  cursor: Record<string, unknown>;
  status: string;
  consecutive_failures: number;
}

export interface ServiceOptions {
  /** fetch de los proveedores (tests: emulador). */
  fetch?: Fetch;
  /** Mundo emulado explícito (tests). En CONNECTORS_DEMO se crea uno con datos de ejemplo. */
  world?: FakeWorld;
  runSeconds?: number;
  maxChangesPerRun?: number;
}

const MAX_FAILURES = 8;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

export class ConnectorService {
  readonly cipher: TokenCipher;
  readonly http: ProviderHttp;
  readonly world?: FakeWorld;
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private soon?: NodeJS.Timeout;

  constructor(private readonly deps: Deps, private readonly opts: ServiceOptions = {}) {
    this.cipher = new TokenCipher(deps.cfg);
    this.world = opts.world ?? (deps.cfg.CONNECTORS_DEMO ? seedDemoWorld(createFakeWorld()) : undefined);
    const f = opts.fetch ?? (this.world ? fakeFetch(this.world) : undefined);
    this.http = providerHttp({ fetch: f, maxInlineWaitMs: opts.fetch || this.world ? 0 : 15_000, retries: opts.fetch || this.world ? 0 : 3 });
  }

  get demo() {
    return !!this.world && !this.opts.fetch;
  }

  client(p: ProviderId): OAuthClient | null {
    const c = this.deps.cfg;
    const pair: Record<ProviderId, [string | undefined, string | undefined]> = {
      gmail: [c.GOOGLE_CLIENT_ID, c.GOOGLE_CLIENT_SECRET],
      slack: [c.SLACK_CLIENT_ID, c.SLACK_CLIENT_SECRET],
      clickup: [c.CLICKUP_CLIENT_ID, c.CLICKUP_CLIENT_SECRET],
    };
    const [id, secret] = pair[p];
    if (id && secret) return { clientId: id, clientSecret: secret };
    return this.world ? { clientId: `demo-${p}`, clientSecret: "demo" } : null;
  }

  available = (p: ProviderId) => this.client(p) !== null;

  redirectUri() {
    return `${this.deps.cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/connect/callback`;
  }

  /** URL de autorización + estado PKCE persistido (un solo uso, 10 min, ligado a la persona). */
  async beginOAuth(db: Db, a: { orgId: string; userId: string; provider: ProviderId; workspaceId: string }): Promise<string> {
    const client = this.client(a.provider)!;
    const state = `${a.orgId}.${randomBytes(24).toString("base64url")}`;
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await db.query("DELETE FROM connector_oauth_states WHERE user_id=$1 AND (expires_at < now() OR consumed_at IS NOT NULL)", [a.userId]);
    await db.query(
      `INSERT INTO connector_oauth_states (organization_id, user_id, provider, workspace_id, state_hash, code_verifier, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6, now() + interval '10 minutes')`,
      [a.orgId, a.userId, a.provider, a.workspaceId, sha256(state), verifier],
    );
    if (this.demo) return `${this.redirectUri()}?${new URLSearchParams({ code: "demo", state })}`;
    return ADAPTERS[a.provider].authorizeUrl({ client, redirectUri: this.redirectUri(), state, codeChallenge: challenge });
  }

  async consumeState(db: Db, state: string) {
    const r = await db.query(
      `UPDATE connector_oauth_states SET consumed_at=now()
        WHERE state_hash=$1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING provider, workspace_id, code_verifier`,
      [sha256(state)],
    );
    return r.rows[0] as { provider: ProviderId; workspace_id: string; code_verifier: string } | undefined;
  }

  seal(conn: { id: string; organization_id: string }, tokens: TokenSet) {
    return this.cipher.seal(tokens, `${conn.organization_id}:${conn.id}`);
  }

  async saveTokens(db: Db, conn: { id: string; organization_id: string }, tokens: TokenSet) {
    await db.query(
      `INSERT INTO connector_credentials (connector_id, organization_id, ciphertext, expires_at, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (connector_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext, expires_at=EXCLUDED.expires_at, updated_at=now()`,
      [conn.id, conn.organization_id, this.seal(conn, tokens), tokens.expires_at ? new Date(tokens.expires_at) : null],
    );
  }

  /** Tokens vigentes del conector (refresca y persiste si caducan en < 2 min). */
  async tokensFor(conn: ConnectorRow): Promise<TokenSet> {
    const ctx = connectorContext(conn);
    const row = (await withContext(this.deps.pool, ctx, (db) => db.query("SELECT ciphertext FROM connector_credentials WHERE connector_id=$1", [conn.id]))).rows[0];
    if (!row) throw new ProviderError("auth_revoked", "no credentials stored");
    let tokens = this.cipher.open(row.ciphertext, `${conn.organization_id}:${conn.id}`);
    const adapter = ADAPTERS[conn.provider as ProviderId];
    if (tokens.expires_at && tokens.expires_at < Date.now() + 120_000 && adapter.refresh) {
      const client = this.client(conn.provider as ProviderId);
      if (!client) throw new ProviderError("provider_error", "provider not configured");
      tokens = await adapter.refresh(this.http, client, tokens);
      await withContext(this.deps.pool, ctx, (db) => this.saveTokens(db, conn, tokens));
    }
    return tokens;
  }

  // -------------------------------------------------------------------------------------------------------------
  // Planificador
  // -------------------------------------------------------------------------------------------------------------

  start() {
    if (!this.deps.cfg.CONNECTOR_SYNC_ENABLED) return;
    this.timer = setInterval(() => this.kick(), 60_000);
    this.timer.unref();
    this.kick();
  }

  /** Programa una pasada del planificador en segundo plano (no bloquea la petición). */
  kick(delayMs = 0) {
    if (!this.deps.cfg.CONNECTOR_SYNC_ENABLED || this.soon) return;
    this.soon = setTimeout(() => {
      this.soon = undefined;
      void this.tick().catch(() => undefined);
    }, delayMs);
    this.soon.unref();
  }

  async stop() {
    clearInterval(this.timer);
    clearTimeout(this.soon);
    await this.running;
  }

  /** Una pasada: sincroniza los conectores vencidos (secuencial; cada uno con su lease). */
  tick(): Promise<void> {
    this.running ??= (async () => {
      try {
        const due = (await withContext(this.deps.pool, {}, (db) => db.query("SELECT * FROM app.due_connectors(5)"))).rows;
        let more = false;
        for (const d of due) more = (await this.runOne(d.connector_id, d.organization_id, d.owner_id, d.workspace_id)) || more;
        if (more) this.kick(5_000);
      } finally {
        this.running = undefined;
      }
    })();
    return this.running;
  }

  private async finish(conn: ConnectorRow, sql: string, params: unknown[] = []) {
    await withContext(this.deps.pool, connectorContext(conn), (db) =>
      db.query(`UPDATE connectors SET lease_until=NULL, updated_at=now(), ${sql} WHERE id=$1`, [conn.id, ...params]),
    );
  }

  private async auditRun(conn: ConnectorRow, action: string, metadata: Record<string, unknown>) {
    await withContext(this.deps.pool, connectorContext(conn), (db) =>
      db.query("INSERT INTO audit_events (organization_id, actor_id, action, resource, decision, metadata) VALUES ($1,$2,$3,$4,'allow',$5::jsonb)", [
        conn.organization_id, conn.owner_id, action, `connector:${conn.id}`, JSON.stringify({ provider: conn.provider, ...metadata }),
      ]),
    );
  }

  /** Sincroniza un conector. Devuelve true si quedó trabajo pendiente. */
  async runOne(connectorId: string, orgId: string, ownerId: string, workspaceId: string): Promise<boolean> {
    const probe: ConnectorRow = { id: connectorId, organization_id: orgId, owner_id: ownerId, workspace_id: workspaceId, provider: "", scope: "personal" };
    // Contexto amplio para leer la fila (personal u organización): el dueño + ambos principales posibles.
    const lease = await withContext(this.deps.pool, { organizationId: orgId, userId: ownerId, principals: [`user:${ownerId}`, `workspace:${workspaceId}`] }, async (db) => {
      const r = await db.query(
        `UPDATE connectors SET lease_until = now() + interval '10 minutes', last_sync_at = now()
          WHERE id=$1 AND status='active' AND (lease_until IS NULL OR lease_until < now())
          RETURNING *, now() AS db_now`,
        [connectorId],
      );
      const row = r.rows[0] as (FullConnectorRow & { db_now: Date }) | undefined;
      if (!row) return null;
      const member = await db.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'", [orgId, ownerId]);
      const wsMember = await db.query("SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2", [workspaceId, ownerId]);
      const plan = (await db.query("SELECT row_to_json(p.*) AS plan FROM organizations o JOIN plans p ON p.id = o.plan_id WHERE o.id=$1", [orgId])).rows[0]?.plan as Plan;
      return { row, member: !!member.rowCount, wsMember: !!wsMember.rowCount, plan };
    });
    if (!lease) return false;
    const { row, plan } = lease;
    const conn: ConnectorRow = { ...probe, provider: row.provider, scope: row.scope };
    const adapter = ADAPTERS[row.provider as ProviderId];

    if (!lease.member) {
      if (conn.scope === "personal") {
        // La persona ya no pertenece a la organización: su correo sale del corpus.
        await this.purge(conn, null, "connector.removed_owner_left");
      } else {
        await this.finish(conn, "status='error', last_error_code='owner_removed', last_error_detail=NULL");
        await this.auditRun(conn, "connector.sync_failed", { reason: "owner_removed" });
      }
      return false;
    }
    if (!lease.wsMember) {
      await this.finish(conn, "status='error', last_error_code='workspace_access_lost', last_error_detail=NULL");
      return false;
    }
    if (!this.client(conn.provider as ProviderId)) {
      await this.finish(conn, "next_sync_at = now() + interval '1 hour', last_error_code='not_configured'");
      return false;
    }

    const sink = new ConnectorSink(
      this.deps,
      conn,
      plan,
      { deadline: Date.now() + (this.opts.runSeconds ?? 240) * 1000, maxChanges: this.opts.maxChangesPerRun ?? 150 },
      row.cursor ?? {},
    );
    try {
      const tokens = await this.tokensFor(conn);
      const settings = adapter.parseSettings(row.settings);
      const outcome = await adapter.sync({
        tokens,
        settings,
        cursor: row.cursor ?? {},
        sink,
        http: this.http,
        now: new Date(row.db_now),
        maxBytes: Number(plan.max_upload_bytes),
        log: () => undefined,
      });
      const minutes = this.deps.cfg.CONNECTOR_SYNC_INTERVAL_MINUTES;
      await this.finish(
        conn,
        `next_sync_at = CASE WHEN $2 THEN now() + interval '5 seconds' ELSE now() + make_interval(mins => $3) END,
         last_success_at = now(), last_error_code = NULL, last_error_detail = NULL, consecutive_failures = 0`,
        [outcome.more, minutes],
      );
      const s = sink.stats;
      if (s.created || s.updated || s.removed) await this.auditRun(conn, "connector.synced", { ...s });
      return outcome.more;
    } catch (err) {
      await this.fail(conn, row.consecutive_failures, err);
      return false;
    }
  }

  private async fail(conn: ConnectorRow, failures: number, err: unknown) {
    if (err instanceof QuotaError) {
      await this.finish(conn, "next_sync_at = now() + interval '6 hours', last_error_code='quota_exceeded', last_error_detail=$2", [err.message]);
      return;
    }
    if (err instanceof ProviderError && err.code === "rate_limited") {
      const secs = Math.max(60, Math.ceil((err.retryAfterMs ?? 60_000) / 1000));
      await this.finish(conn, "next_sync_at = now() + make_interval(secs => $2), last_error_code='rate_limited', last_error_detail=NULL", [secs]);
      return;
    }
    if (err instanceof ProviderError && err.code === "auth_revoked") {
      await this.finish(conn, "status='error', last_error_code='reconnect_needed', last_error_detail=$2", [err.message.slice(0, 300)]);
      await this.auditRun(conn, "connector.sync_failed", { reason: "reconnect_needed" }).catch(() => undefined);
      return;
    }
    const n = failures + 1;
    const minutes = Math.min(360, 5 * 2 ** (n - 1));
    const detail = (err instanceof Error ? err.message : String(err)).slice(0, 300);
    await this.finish(
      conn,
      `consecutive_failures = $2, last_error_code='sync_failed', last_error_detail=$3,
       next_sync_at = now() + make_interval(mins => $4), status = CASE WHEN $2 >= ${MAX_FAILURES} THEN 'error' ELSE status END`,
      [n, detail, minutes],
    ).catch(() => undefined);
  }

  /**
   * Desconecta: revoca el token en el proveedor (mejor esfuerzo), retira del corpus todo lo sincronizado y borra el
   * conector con sus credenciales. `actorId` null = acción del sistema (dueño fuera de la organización).
   */
  async purge(conn: ConnectorRow, actorId: string | null, action = "connector.disconnected"): Promise<number> {
    const client = this.client(conn.provider as ProviderId);
    const adapter = ADAPTERS[conn.provider as ProviderId];
    if (client && adapter.revoke) {
      try {
        const tokens = await this.tokensFor(conn);
        await adapter.revoke(this.http, client, tokens);
      } catch {}
    }
    const out = await withContext(this.deps.pool, connectorContext(conn), async (db) => {
      const locked = await db.query("SELECT 1 FROM connectors WHERE id=$1 FOR UPDATE", [conn.id]);
      if (!locked.rowCount) return { msgs: [], removed: 0 };
      const items = await db.query("SELECT document_id FROM connector_items WHERE connector_id=$1", [conn.id]);
      const msgs = await tombstoneDocuments(db, conn.organization_id, items.rows.map((r) => r.document_id));
      await db.query("DELETE FROM connectors WHERE id=$1", [conn.id]);
      await db.query("INSERT INTO audit_events (organization_id, actor_id, action, resource, decision, metadata) VALUES ($1,$2,$3,$4,'allow',$5::jsonb)", [
        conn.organization_id, actorId, action, `connector:${conn.id}`, JSON.stringify({ provider: conn.provider, removed_items: items.rowCount }),
      ]);
      return { msgs, removed: items.rowCount ?? 0 };
    });
    for (const m of out.msgs) await this.deps.queue.send(m);
    return out.removed;
  }
}
