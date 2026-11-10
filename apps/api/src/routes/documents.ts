import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { ApiError, badRequest, conflict, notFound, quotaExceeded } from "../lib/errors.js";
import { currentTraceparent } from "../lib/telemetry.js";
import { assertUuid, audit, requireWorkspaceRead, requireWorkspaceWrite, tx, type TenantContext } from "../lib/tenant.js";

export const ALLOWED_TYPES = new Set([
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "image/png",
  "image/jpeg",
  "text/plain",
  "text/markdown",
  "text/html",
  "text/csv",
]);

const Principal = z.string().regex(/^(workspace|group|user):[0-9a-f-]{36}$/);
const FileSpec = z.object({
  filename: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .refine((f) => !/[\\/\0]/.test(f), "invalid filename"),
  content_type: z.string().refine((c) => ALLOWED_TYPES.has(c.split(";")[0]!.trim().toLowerCase()), "tipo no permitido"),
  size_bytes: z.number().int().positive(),
  effective_from: z.string().date().optional(),
  effective_to: z.string().date().optional(),
});
const StartUpload = FileSpec.extend({
  workspace_id: z.string().uuid(),
  title: z.string().trim().max(300).optional(),
  source_id: z.string().max(300).optional(),
  classification: z.enum(["public", "internal", "confidential", "restricted"]).default("internal"),
  acl: z.array(Principal).max(50).optional(),
});

// Solo IDs y traceparent (si hay trazas activas): nunca contenido ni secretos en la cola.
const traceField = (req: Parameters<typeof currentTraceparent>[0]) => {
  const tp = currentTraceparent(req);
  return tp ? { traceparent: tp } : {};
};

const safeName = (f: string) => f.replace(/[^\w.\-]+/g, "_").slice(0, 120);

async function checkQuota(db: Db, t: TenantContext, size: number): Promise<void> {
  if (size > Number(t.plan.max_upload_bytes)) throw badRequest(`file exceeds the plan maximum (${t.plan.max_upload_bytes} bytes)`);
  // Agregado tenant-wide vía función SECURITY DEFINER (la ACL del usuario no debe sesgar la cuota).
  const r = await db.query("SELECT documents AS docs, storage_bytes::float8 AS storage FROM app.tenant_corpus_stats()");
  const { docs, storage } = r.rows[0];
  if (docs >= t.plan.max_documents) throw quotaExceeded("plan document limit reached");
  if (storage + size > Number(t.plan.max_storage_bytes)) throw quotaExceeded("plan storage limit reached");
}

function validateAcl(t: TenantContext, workspaceId: string, acl: string[] | undefined): string[] {
  const list = acl?.length ? acl : [`workspace:${workspaceId}`];
  for (const p of list) {
    const [kind, id] = p.split(":") as [string, string];
    if (kind === "workspace" && id !== workspaceId) throw badRequest("ACL de workspace debe referir el workspace del documento");
    if (kind === "group" && !t.groups.includes(id) && t.role !== "owner" && t.role !== "admin")
      throw badRequest("solo admins pueden asignar grupos de los que no son miembros");
  }
  // Quien sube siempre conserva acceso para poder verificar la ingesta.
  if (!list.includes(`user:${t.userId}`) && !list.includes(`workspace:${workspaceId}`)) list.push(`user:${t.userId}`);
  return [...new Set(list)];
}

export async function documentRoutes(app: FastifyInstance, deps: Deps) {
  const { pool, storage, queue, cfg } = deps;

  const createVersion = async (
    db: Db,
    t: TenantContext,
    documentId: string,
    versionNo: number,
    f: z.infer<typeof FileSpec>,
  ) => {
    const versionId = randomUUID();
    const key = `tenants/${t.organizationId}/raw/${documentId}/${versionId}/${safeName(f.filename)}`;
    await db.query(
      `INSERT INTO document_versions (id, organization_id, document_id, version_no, filename, content_type, declared_size,
         s3_key, status, created_by, effective_from, effective_to)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending_upload',$9,$10,$11)`,
      [versionId, t.organizationId, documentId, versionNo, f.filename, f.content_type.split(";")[0]!.trim().toLowerCase(),
       f.size_bytes, key, t.userId, f.effective_from ?? null, f.effective_to ?? null],
    );
    const url = await storage.presignPut(key, f.content_type, cfg.UPLOAD_URL_TTL_SECONDS);
    return {
      version_id: versionId,
      upload: { method: "PUT", url, headers: { "Content-Type": f.content_type }, expires_in: cfg.UPLOAD_URL_TTL_SECONDS },
    };
  };

  /** POST /uploads: crea documento + versión pending y entrega URL prefirmada (upload directo a S3). */
  app.post("/v1/organizations/:org/documents/uploads", { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    const body = StartUpload.parse(req.body);
    requireWorkspaceWrite(t, body.workspace_id);
    const acl = validateAcl(t, body.workspace_id, body.acl);
    const documentId = randomUUID();
    const out = await tx(pool, t, async (db) => {
      await checkQuota(db, t, body.size_bytes);
      try {
        await db.query(
          `INSERT INTO documents (id, organization_id, workspace_id, source_id, title, classification, owner_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [documentId, t.organizationId, body.workspace_id, body.source_id ?? null, body.title || body.filename, body.classification, t.userId],
        );
      } catch (err: unknown) {
        if ((err as { code?: string }).code === "23505") throw conflict("source_id already exists in the workspace; create a new version");
        throw err;
      }
      for (const p of acl) {
        await db.query("INSERT INTO document_acl (document_id, organization_id, principal) VALUES ($1,$2,$3)", [documentId, t.organizationId, p]);
      }
      const v = await createVersion(db, t, documentId, 1, body);
      await audit(db, t, "document.upload_started", `document:${documentId}`, "allow", { version_id: v.version_id, acl });
      return v;
    });
    reply.code(201);
    return { document_id: documentId, ...out };
  });

  /** POST /documents/:id/versions: nueva versión de un documento visible para el usuario. */
  app.post("/v1/organizations/:org/documents/:id/versions", { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "documento");
    const body = FileSpec.parse(req.body);
    const out = await tx(pool, t, async (db) => {
      const d = await db.query("SELECT workspace_id, status FROM documents WHERE id=$1 FOR UPDATE", [id]);
      const doc = d.rows[0];
      if (!doc || doc.status !== "active") throw notFound("documento");
      requireWorkspaceWrite(t, doc.workspace_id);
      await checkQuota(db, t, body.size_bytes);
      const n = await db.query("SELECT coalesce(max(version_no), 0) + 1 AS n FROM document_versions WHERE document_id=$1", [id]);
      const v = await createVersion(db, t, id, n.rows[0].n, body);
      await audit(db, t, "document.version_started", `document:${id}`, "allow", { version_id: v.version_id });
      return { ...v, version_no: n.rows[0].n };
    });
    reply.code(201);
    return { document_id: id, ...out };
  });

  /** POST .../complete: verifica el objeto en S3, crea job idempotente y publica en SQS. */
  app.post("/v1/organizations/:org/documents/:id/versions/:ver/complete", { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    const { id, ver } = req.params as { id: string; ver: string };
    assertUuid(id, "documento");
    assertUuid(ver, "version");
    const job = await tx(pool, t, async (db) => {
      const r = await db.query(
        `SELECT v.status, v.s3_key, v.declared_size, d.workspace_id, d.status AS doc_status
           FROM document_versions v JOIN documents d ON d.id = v.document_id
          WHERE v.id = $1 AND v.document_id = $2 FOR UPDATE OF v`,
        [ver, id],
      );
      const v = r.rows[0];
      if (!v || v.doc_status !== "active") throw notFound("version");
      requireWorkspaceWrite(t, v.workspace_id);
      const idem = `ingest:${ver}`;
      if (v.status !== "pending_upload") {
        const existing = await db.query("SELECT id, state FROM ingestion_jobs WHERE idempotency_key=$1", [idem]);
        if (existing.rows[0]) return { id: existing.rows[0].id as string, state: existing.rows[0].state as string, replay: true };
        throw conflict(`version in status ${v.status}`);
      }
      const head = await storage.head(v.s3_key);
      if (!head) throw badRequest("the object has not been uploaded to S3 yet");
      if (head.size !== Number(v.declared_size)) {
        await db.query("UPDATE document_versions SET status='rejected', error_code='size_mismatch' WHERE id=$1", [ver]);
        await audit(db, t, "document.rejected", `document_version:${ver}`, "deny", { reason: "size_mismatch" });
        throw badRequest("uploaded size does not match the declared size");
      }
      await db.query("UPDATE document_versions SET status='uploaded', size_bytes=$2 WHERE id=$1", [ver, head.size]);
      const jobId = randomUUID();
      await db.query(
        "INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, version_id, idempotency_key) VALUES ($1,$2,'ingest',$3,$4,$5)",
        [jobId, t.organizationId, id, ver, idem],
      );
      await audit(db, t, "document.uploaded", `document_version:${ver}`, "allow", { job_id: jobId, size: head.size });
      return { id: jobId, state: "queued", replay: false };
    });
    if (!job.replay) {
      await queue.send({ v: 1, kind: "ingest", organization_id: t.organizationId, document_id: id, version_id: ver, job_id: job.id,
                         ...traceField(req) });
    }
    reply.code(202);
    return { job_id: job.id, state: job.state };
  });

  app.get("/v1/organizations/:org/documents", { config: { scopes: ["documents:read"] } }, async (req) => {
    const t = req.tenant!;
    const q = z
      .object({ workspace_id: z.string().uuid(), limit: z.coerce.number().int().min(1).max(200).default(50), q: z.string().max(200).optional() })
      .parse(req.query);
    requireWorkspaceRead(t, q.workspace_id);
    const rows = await tx(pool, t, async (db) =>
      (
        await db.query(
          `SELECT d.id, d.title, d.classification, d.status, d.created_at, d.updated_at,
                  lv.id AS latest_version_id, lv.version_no, lv.status AS latest_status, lv.filename, lv.size_bytes,
                  lv.page_count, lv.chunk_count, lv.error_code, lv.indexed_at, d.current_version_id, src.provider AS source_provider
             FROM documents d
             LEFT JOIN LATERAL (SELECT * FROM document_versions v WHERE v.document_id = d.id ORDER BY version_no DESC LIMIT 1) lv ON true
             LEFT JOIN LATERAL (SELECT c.provider FROM connector_items ci JOIN connectors c ON c.id = ci.connector_id
                                 WHERE ci.document_id = d.id LIMIT 1) src ON true
            WHERE d.workspace_id = $1 AND d.status = 'active'
              AND ($3::text IS NULL OR d.title ILIKE '%' || $3 || '%')
            ORDER BY d.updated_at DESC LIMIT $2`,
          [q.workspace_id, q.limit, q.q ?? null],
        )
      ).rows,
    );
    return { documents: rows };
  });

  app.get("/v1/organizations/:org/documents/:id/status", { config: { scopes: ["documents:read"] } }, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "documento");
    return tx(pool, t, async (db) => {
      const d = await db.query("SELECT id, title, status, workspace_id, current_version_id FROM documents WHERE id=$1", [id]);
      if (!d.rows[0]) throw notFound("documento");
      requireWorkspaceRead(t, d.rows[0].workspace_id);
      const v = await db.query(
        `SELECT id, version_no, filename, status, error_code, error_detail, page_count, chunk_count, parser, parser_version,
                pipeline_version, embedding_model, is_current, effective_from, effective_to, created_at, indexed_at
           FROM document_versions WHERE document_id=$1 ORDER BY version_no DESC`,
        [id],
      );
      return { document: d.rows[0], versions: v.rows };
    });
  });

  /** URL firmada corta, emitida bajo demanda y auditada; no se persiste en historiales. `?disposition=inline` para vista previa. */
  app.get("/v1/organizations/:org/documents/:id/versions/:ver/download", { config: { scopes: ["documents:read"] } }, async (req) => {
    const t = req.tenant!;
    const { id, ver } = req.params as { id: string; ver: string };
    const inline = (req.query as { disposition?: string }).disposition === "inline";
    assertUuid(id, "documento");
    assertUuid(ver, "version");
    const row = await tx(pool, t, async (db) => {
      const r = await db.query(
        `SELECT v.s3_key, v.filename, v.status, d.workspace_id FROM document_versions v JOIN documents d ON d.id = v.document_id
          WHERE v.id=$1 AND v.document_id=$2 AND d.status='active'`,
        [ver, id],
      );
      const v = r.rows[0];
      if (!v || !["indexed", "superseded"].includes(v.status)) throw notFound("version");
      requireWorkspaceRead(t, v.workspace_id);
      await audit(db, t, "document.download_url_issued", `document_version:${ver}`);
      return v;
    });
    if (!row.s3_key.startsWith(`tenants/${t.organizationId}/`)) throw new ApiError(500, "storage_boundary_violation");
    // Vista previa embebida: texto/markdown/CSV/HTML se sirven como text/plain (el navegador los muestra en vez de
    // descargarlos y el HTML no se ejecuta); el resto conserva su content-type.
    const textLike = /\.(txt|md|markdown|csv|html?)$/i.test(row.filename);
    const url = inline
      ? await storage.presignGet(row.s3_key, row.filename, cfg.DOWNLOAD_URL_TTL_SECONDS, "inline", textLike ? "text/plain; charset=utf-8" : undefined)
      : await storage.presignGet(row.s3_key, row.filename, cfg.DOWNLOAD_URL_TTL_SECONDS);
    return { url, expires_in: cfg.DOWNLOAD_URL_TTL_SECONDS };
  });

  /**
   * RAG-04: URL firmada corta (inline) de la imagen de una figura citada. La fila del chunk solo es visible si
   * el usuario pasa RLS + ACL del documento; además se exige lectura del workspace y prefijo S3 del tenant.
   */
  app.get("/v1/organizations/:org/chunks/:chunk/asset", { config: { scopes: ["documents:read"] } }, async (req) => {
    const t = req.tenant!;
    const chunk = assertUuid((req.params as { chunk: string }).chunk, "fragmento");
    const row = await tx(pool, t, async (db) => {
      const r = await db.query(
        `SELECT c.asset_key, c.kind, c.version_id, d.workspace_id FROM chunks c JOIN documents d ON d.id = c.document_id
          WHERE c.id=$1 AND d.status='active' AND c.index_state IN ('active', 'superseded') AND c.asset_key IS NOT NULL`,
        [chunk],
      );
      const c = r.rows[0];
      if (!c) throw notFound("fragmento");
      requireWorkspaceRead(t, c.workspace_id);
      await audit(db, t, "chunk.asset_url_issued", `chunk:${chunk}`, "allow", { version_id: c.version_id });
      return c;
    });
    if (!row.asset_key.startsWith(`tenants/${t.organizationId}/assets/`)) throw new ApiError(500, "storage_boundary_violation");
    const name = row.asset_key.slice(row.asset_key.lastIndexOf("/") + 1);
    return {
      url: await storage.presignGet(row.asset_key, name, cfg.DOWNLOAD_URL_TTL_SECONDS, "inline"),
      expires_in: cfg.DOWNLOAD_URL_TTL_SECONDS,
    };
  });

  /** DELETE: invisible de inmediato para retrieval; el worker purga chunks, embeddings y objetos. */
  app.delete("/v1/organizations/:org/documents/:id", { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "documento");
    const jobId = await tx(pool, t, async (db) => {
      const d = await db.query("SELECT workspace_id, status FROM documents WHERE id=$1 FOR UPDATE", [id]);
      const doc = d.rows[0];
      if (!doc || doc.status !== "active") throw notFound("documento");
      requireWorkspaceWrite(t, doc.workspace_id);
      await db.query("UPDATE documents SET status='deleting', updated_at=now() WHERE id=$1", [id]);
      const jid = randomUUID();
      await db.query(
        "INSERT INTO ingestion_jobs (id, organization_id, kind, document_id, idempotency_key) VALUES ($1,$2,'delete',$3,$4)",
        [jid, t.organizationId, id, `delete:${id}`],
      );
      await audit(db, t, "document.deleted", `document:${id}`);
      return jid;
    });
    await queue.send({ v: 1, kind: "delete", organization_id: t.organizationId, document_id: id, version_id: null, job_id: jobId,
                       ...traceField(req) });
    reply.code(202);
    return { job_id: jobId, state: "queued" };
  });
}
