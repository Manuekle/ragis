/**
 * Puente entre un proveedor y el corpus: cada elemento sincronizado se convierte en documento/versión normal y entra
 * por el mismo pipeline de ingesta (SQS → worker). Corre con RLS del dueño del conector: solo puede tocar documentos
 * cuya ACL es el principal del conector.
 */
import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { withContext, type Db, type SecurityContext } from "../../db/pool.js";
import type { Queue, Storage } from "../aws.js";
import type { Plan } from "../tenant.js";
import type { KnownItem, SyncItem, SyncSink, UpsertResult } from "./types.js";

export class QuotaError extends Error {}

export interface ConnectorRow {
  id: string;
  organization_id: string;
  provider: string;
  scope: "personal" | "organization";
  owner_id: string;
  workspace_id: string;
}

export const connectorPrincipal = (c: ConnectorRow) => (c.scope === "personal" ? `user:${c.owner_id}` : `workspace:${c.workspace_id}`);

/** Contexto RLS del conector: el dueño + el principal de la ACL de sus documentos. */
export const connectorContext = (c: ConnectorRow): SecurityContext => ({
  organizationId: c.organization_id,
  userId: c.owner_id,
  principals: [...new Set([`user:${c.owner_id}`, connectorPrincipal(c)])],
});

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const safeKeyName = (f: string) => f.replace(/[^\w.\-]+/g, "_").slice(0, 120) || "item";
const safeFilename = (f: string) => f.replace(/[\\/\0]/g, "_").trim().slice(0, 200) || "item";

type IngestMsg = Record<string, unknown>;

/** Marca documentos como 'deleting' y crea sus jobs de borrado (idempotentes). source_id se libera para recrearlos. */
export async function tombstoneDocuments(db: Db, orgId: string, documentIds: string[]): Promise<IngestMsg[]> {
  if (!documentIds.length) return [];
  const docs = await db.query(
    "UPDATE documents SET status='deleting', source_id=NULL, updated_at=now() WHERE id = ANY($1::uuid[]) AND status='active' RETURNING id",
    [documentIds],
  );
  if (!docs.rowCount) return [];
  const jobs = await db.query(
    `INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, idempotency_key)
     SELECT gen_random_uuid(), $1, 'delete', d, 'delete:' || d FROM unnest($2::uuid[]) d
     ON CONFLICT (organization_id, idempotency_key) DO NOTHING RETURNING id, document_id`,
    [orgId, docs.rows.map((r) => r.id)],
  );
  return jobs.rows.map((j) => ({ v: 1, kind: "delete", organization_id: orgId, document_id: j.document_id, version_id: null, job_id: j.id }));
}

export interface SinkLimits {
  deadline: number;
  maxChanges: number;
}

export class ConnectorSink implements SyncSink {
  readonly stats = { created: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0 };
  private changes = 0;
  private cursor: Record<string, unknown>;
  private readonly ctx: SecurityContext;

  constructor(
    private readonly deps: { pool: pg.Pool; storage: Storage; queue: Queue },
    private readonly conn: ConnectorRow,
    private readonly plan: Plan,
    private readonly limits: SinkLimits,
    cursor: Record<string, unknown>,
  ) {
    this.ctx = connectorContext(conn);
    this.cursor = cursor;
  }

  get currentCursor() {
    return this.cursor;
  }

  get maxBytes() {
    return Number(this.plan.max_upload_bytes);
  }

  private tx<T>(fn: (db: Db) => Promise<T>) {
    return withContext(this.deps.pool, this.ctx, async (db) => {
      // FOR SHARE: una desconexión concurrente espera a que termine esta escritura (y las siguientes ya no ven el conector).
      const c = await db.query("SELECT 1 FROM connectors WHERE id=$1 FOR SHARE", [this.conn.id]);
      if (!c.rowCount) throw new Error("connector no longer exists");
      return fn(db);
    });
  }

  private async send(msgs: IngestMsg[]) {
    for (const m of msgs) await this.deps.queue.send(m);
  }

  private async checkQuota(db: Db, size: number, newDocument: boolean) {
    if (size > Number(this.plan.max_upload_bytes)) throw new QuotaError("file exceeds the plan maximum");
    const r = await db.query("SELECT documents AS docs, storage_bytes::float8 AS storage FROM app.tenant_corpus_stats()");
    const { docs, storage } = r.rows[0];
    if (newDocument && docs >= this.plan.max_documents) throw new QuotaError("plan document limit reached");
    if (storage + size > Number(this.plan.max_storage_bytes)) throw new QuotaError("plan storage limit reached");
  }

  async upsert(item: SyncItem): Promise<UpsertResult> {
    if (!item.body.length || item.body.length > this.maxBytes) {
      this.stats.skipped++;
      return "skipped";
    }
    const sha = sha256(item.body);
    const c = this.conn;
    const out = await this.tx(async (db): Promise<{ result: UpsertResult; msg?: IngestMsg }> => {
      const k = (await db.query("SELECT document_id, content_sha256 FROM connector_items WHERE connector_id=$1 AND source_id=$2 FOR UPDATE", [c.id, item.sourceId])).rows[0];
      const touch = () =>
        db.query("UPDATE connector_items SET last_seen_at=now(), container=$3, source_updated_at=$4, content_sha256=$5 WHERE connector_id=$1 AND source_id=$2", [
          c.id, item.sourceId, item.container, item.sourceUpdatedAt ?? null, sha,
        ]);
      if (k && k.content_sha256 === sha) {
        await touch();
        return { result: "unchanged" };
      }
      let documentId: string;
      let versionNo = 1;
      let created = false;
      if (k) {
        const d = (await db.query("SELECT status FROM documents WHERE id=$1 FOR UPDATE", [k.document_id])).rows[0];
        if (!d || d.status !== "active") {
          // Alguien lo quitó desde la biblioteca: se respeta y no se vuelve a crear.
          await touch();
          return { result: "skipped" };
        }
        await this.checkQuota(db, item.body.length, false);
        documentId = k.document_id;
        versionNo = (await db.query("SELECT coalesce(max(version_no), 0) + 1 AS n FROM document_versions WHERE document_id=$1", [documentId])).rows[0].n;
        await db.query("UPDATE documents SET title=$2, classification=$3, updated_at=now() WHERE id=$1", [documentId, item.title, item.classification ?? "internal"]);
      } else {
        await this.checkQuota(db, item.body.length, true);
        documentId = randomUUID();
        created = true;
        await db.query(
          `INSERT INTO documents (id, organization_id, workspace_id, source_id, title, classification, owner_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [documentId, c.organization_id, c.workspace_id, `con:${c.id}:${item.sourceId}`, item.title, item.classification ?? "internal", c.owner_id],
        );
        await db.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [documentId, c.organization_id, connectorPrincipal(c)]);
      }
      const versionId = randomUUID();
      const filename = safeFilename(item.filename);
      const key = `tenants/${c.organization_id}/raw/${documentId}/${versionId}/${safeKeyName(filename)}`;
      await db.query(
        `INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type, declared_size, size_bytes,
           s3_key, status, created_by, effective_from)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,'uploaded',$9,$10)`,
        [versionId, c.organization_id, documentId, versionNo, filename, item.contentType, item.body.length, key, c.owner_id, item.effectiveFrom ?? null],
      );
      await this.deps.storage.put(key, item.body, item.contentType);
      const jobId = randomUUID();
      await db.query(
        "INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, version_id, idempotency_key) VALUES ($1,$2,'ingest',$3,$4,$5)",
        [jobId, c.organization_id, documentId, versionId, `ingest:${versionId}`],
      );
      await db.query(
        `INSERT INTO connector_items (connector_id, organization_id, source_id, document_id, container, content_sha256, source_updated_at, last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now())
         ON CONFLICT (connector_id, source_id) DO UPDATE SET document_id=EXCLUDED.document_id, container=EXCLUDED.container,
           content_sha256=EXCLUDED.content_sha256, source_updated_at=EXCLUDED.source_updated_at, last_seen_at=now()`,
        [c.id, c.organization_id, item.sourceId, documentId, item.container, sha, item.sourceUpdatedAt ?? null],
      );
      return {
        result: created ? "created" : "updated",
        msg: { v: 1, kind: "ingest", organization_id: c.organization_id, document_id: documentId, version_id: versionId, job_id: jobId },
      };
    });
    if (out.msg) {
      await this.send([out.msg]);
      this.changes++;
    }
    this.stats[out.result]++;
    return out.result;
  }

  async touch(sourceIds: string[]) {
    if (!sourceIds.length) return;
    await this.tx((db) => db.query("UPDATE connector_items SET last_seen_at=now() WHERE connector_id=$1 AND source_id = ANY($2::text[])", [this.conn.id, sourceIds]));
  }

  async touchContainers(containers: string[]) {
    if (!containers.length) return;
    await this.tx((db) => db.query("UPDATE connector_items SET last_seen_at=now() WHERE connector_id=$1 AND container = ANY($2::text[])", [this.conn.id, containers]));
  }

  async known(sourceId: string): Promise<KnownItem | null> {
    const r = await this.tx((db) => db.query("SELECT content_sha256, source_updated_at FROM connector_items WHERE connector_id=$1 AND source_id=$2", [this.conn.id, sourceId]));
    const row = r.rows[0];
    return row ? { contentSha256: row.content_sha256, sourceUpdatedAt: row.source_updated_at } : null;
  }

  async remove(sourceIds: string[]): Promise<number> {
    let removed = 0;
    for (let i = 0; i < sourceIds.length; i += 200) {
      const batch = sourceIds.slice(i, i + 200);
      const msgs = await this.tx(async (db) => {
        const items = await db.query("DELETE FROM connector_items WHERE connector_id=$1 AND source_id = ANY($2::text[]) RETURNING document_id", [this.conn.id, batch]);
        removed += items.rowCount ?? 0;
        return tombstoneDocuments(db, this.conn.organization_id, items.rows.map((r) => r.document_id));
      });
      await this.send(msgs);
    }
    this.stats.removed += removed;
    if (removed) this.changes++;
    return removed;
  }

  private async removeWhere(sql: string, params: unknown[]): Promise<number> {
    const r = await this.tx((db) => db.query(`SELECT source_id FROM connector_items WHERE connector_id=$1 AND ${sql}`, [this.conn.id, ...params]));
    return this.remove(r.rows.map((x) => x.source_id));
  }

  retain(container: string, keep: string[]) {
    return this.removeWhere("container = $2 AND NOT (source_id = ANY($3::text[]))", [container, keep]);
  }

  keepContainers(prefix: string, containers: string[]) {
    return this.removeWhere("left(container, length($2)) = $2 AND NOT (container = ANY($3::text[]))", [prefix, containers]);
  }

  sweep(sourcePrefix: string, since: Date) {
    return this.removeWhere("left(source_id, length($2)) = $2 AND last_seen_at < $3", [sourcePrefix, since]);
  }

  async checkpoint(cursor: Record<string, unknown>) {
    this.cursor = cursor;
    await this.tx((db) =>
      db.query("UPDATE connectors SET cursor=$2::jsonb, lease_until=now() + interval '10 minutes', updated_at=now() WHERE id=$1", [this.conn.id, JSON.stringify(cursor)]),
    );
  }

  shouldYield() {
    return Date.now() > this.limits.deadline || this.changes >= this.limits.maxChanges;
  }
}
