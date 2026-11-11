import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { assertUuid, audit, requireWorkspaceRead, requireWorkspaceWrite, tx } from "../lib/tenant.js";

/**
 * Carpetas de la biblioteca (ADR-031). Solo organizan: el acceso a cada documento sigue siendo su ACL, así que
 * mover un documento no cambia quién lo ve. Los nombres de carpeta son visibles para todo el workspace; los
 * conteos y las sugerencias se calculan bajo RLS, solo con documentos que la persona puede leer.
 */

// Similitud coseno mínima entre el documento y el promedio de una carpeta para sugerirla. Por debajo, se prefiere
// no sugerir nada a sugerir mal.
export const MIN_FOLDER_SIMILARITY = 0.45;
// Una carpeta con un solo documento parecido es poca evidencia: se le pide más parecido.
export const MIN_SINGLE_DOC_SIMILARITY = 0.6;

const Name = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .refine((n) => !/[\\/\0]/.test(n), "folder names cannot contain slashes");
const CreateFolder = z.object({ workspace_id: z.string().uuid(), name: Name, parent_id: z.string().uuid().nullish() });
const UpdateFolder = z
  .object({ name: Name.optional(), parent_id: z.string().uuid().nullable().optional() })
  .refine((b) => b.name !== undefined || b.parent_id !== undefined, "nothing to change");
const MoveDocuments = z.object({
  document_ids: z.array(z.string().uuid()).min(1).max(200),
  folder_id: z.string().uuid().nullable(),
});

/** Traduce las violaciones de la BD (nombre repetido, ciclo, profundidad, otro workspace) a errores legibles. */
function folderError(err: unknown): never {
  const e = err as { code?: string; message?: string };
  if (e.code === "23505") throw conflict("a folder with that name already exists here");
  if (e.code === "23514") throw badRequest(e.message ?? "invalid folder");
  throw err;
}

export interface FolderSuggestion {
  document_id: string;
  folder_id: string;
  folder_name: string;
  score: number;
  reason: "similar_content" | "name_match";
}

/**
 * Carpeta sugerida para documentos sin carpeta. Dos señales, en este orden:
 *  1. Contenido: el vector resumen del documento frente al promedio de los documentos visibles de cada carpeta.
 *  2. Nombre: el nombre de la carpeta aparece en el título o en el texto del documento (sirve para carpetas
 *     recién creadas y todavía vacías).
 * Todo se lee bajo RLS: un documento que la persona no puede ver no aporta al promedio de su carpeta.
 */
export async function suggestFolders(db: Db, workspaceId: string, documentIds: string[] | null, limit = 60): Promise<FolderSuggestion[]> {
  const r = await db.query(
    `WITH target AS (
       SELECT d.id, d.title, v.embedding_model
         FROM documents d JOIN document_versions v ON v.id = d.current_version_id
        WHERE d.workspace_id = $1 AND d.status = 'active' AND d.folder_id IS NULL
          AND d.folder_suggestion_dismissed_at IS NULL
          AND ($2::uuid[] IS NULL OR d.id = ANY($2::uuid[]))
        ORDER BY d.updated_at DESC LIMIT $3
     ), foldervec AS (
       SELECT d.folder_id, c.model_version, avg(c.embedding) AS v, count(*) AS n
         FROM documents d JOIN document_centroids c ON c.document_id = d.id
        WHERE d.workspace_id = $1 AND d.status = 'active' AND d.folder_id IS NOT NULL
        GROUP BY d.folder_id, c.model_version
     ), by_content AS (
       SELECT t.id AS document_id, fv.folder_id, 1 - (fv.v <=> c.embedding) AS score, fv.n
         FROM target t
         JOIN document_centroids c ON c.document_id = t.id AND c.model_version = t.embedding_model
         JOIN foldervec fv ON fv.model_version = c.model_version
     ), named AS (
       SELECT t.id AS document_id, f.id AS folder_id,
              (CASE WHEN to_tsvector('spanish', t.title) @@ plainto_tsquery('spanish', f.name) THEN 1 ELSE 0 END
               + (SELECT count(*) FILTER (WHERE ch.tsv @@ plainto_tsquery('spanish', f.name))::float8
                         / GREATEST(count(*), 1)
                    FROM chunks ch WHERE ch.document_id = t.id AND ch.index_state = 'active')) AS score
         FROM target t CROSS JOIN folders f
        WHERE f.workspace_id = $1 AND numnode(plainto_tsquery('spanish', f.name)) > 0
     ), candidates AS (
       SELECT document_id, folder_id, score, 'similar_content' AS reason, 2 AS prio FROM by_content
        WHERE score >= CASE WHEN n = 1 THEN $5::float8 ELSE $4::float8 END
       UNION ALL
       SELECT document_id, folder_id, score, 'name_match', 1 FROM named WHERE score > 0
     ), best AS (
       SELECT DISTINCT ON (document_id) document_id, folder_id, score, reason
         FROM candidates ORDER BY document_id, prio DESC, score DESC, folder_id
     )
     SELECT b.document_id, b.folder_id, f.name AS folder_name, b.score::float8 AS score, b.reason
       FROM best b JOIN folders f ON f.id = b.folder_id`,
    [workspaceId, documentIds, limit, MIN_FOLDER_SIMILARITY, MIN_SINGLE_DOC_SIMILARITY],
  );
  return r.rows.map((x) => ({ ...x, score: Math.round(x.score * 1000) / 1000 }));
}

export async function folderRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const base = "/v1/organizations/:org/folders";

  /** Árbol plano (cada carpeta con su parent_id) y cuántos documentos visibles tiene cada una. */
  app.get(base, { config: { scopes: ["documents:read"] } }, async (req) => {
    const t = req.tenant!;
    const q = z.object({ workspace_id: z.string().uuid() }).parse(req.query);
    requireWorkspaceRead(t, q.workspace_id);
    return tx(pool, t, async (db) => {
      const folders = await db.query(
        `SELECT f.id, f.name, f.parent_id, f.created_at, f.updated_at,
                (SELECT count(*)::int FROM documents d WHERE d.folder_id = f.id AND d.status = 'active') AS document_count
           FROM folders f WHERE f.workspace_id = $1 ORDER BY lower(f.name)`,
        [q.workspace_id],
      );
      const unfiled = await db.query(
        "SELECT count(*)::int AS n FROM documents WHERE workspace_id = $1 AND status = 'active' AND folder_id IS NULL",
        [q.workspace_id],
      );
      return { folders: folders.rows, unfiled_count: unfiled.rows[0].n };
    });
  });

  app.post(base, { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    const body = CreateFolder.parse(req.body);
    requireWorkspaceWrite(t, body.workspace_id);
    const row = await tx(pool, t, async (db) => {
      try {
        const r = await db.query(
          `INSERT INTO folders (organization_id, workspace_id, parent_id, name, created_by)
           VALUES ($1,$2,$3,$4,$5) RETURNING id, name, parent_id, created_at, updated_at`,
          [t.organizationId, body.workspace_id, body.parent_id ?? null, body.name, t.userId],
        );
        await audit(db, t, "folder.created", `folder:${r.rows[0].id}`, "allow", { parent_id: body.parent_id ?? null });
        return r.rows[0];
      } catch (err) {
        folderError(err);
      }
    });
    reply.code(201);
    return { ...row, document_count: 0 };
  });

  /** Renombrar o mover la carpeta dentro del mismo workspace. */
  app.patch(`${base}/:id`, { config: { scopes: ["documents:write"] } }, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "folder");
    const body = UpdateFolder.parse(req.body);
    return tx(pool, t, async (db) => {
      const cur = await db.query("SELECT workspace_id, name, parent_id FROM folders WHERE id = $1 FOR UPDATE", [id]);
      if (!cur.rows[0]) throw notFound("folder");
      requireWorkspaceWrite(t, cur.rows[0].workspace_id);
      try {
        const r = await db.query(
          `UPDATE folders SET name = $2, parent_id = $3, updated_at = now() WHERE id = $1
           RETURNING id, name, parent_id, created_at, updated_at`,
          [id, body.name ?? cur.rows[0].name, body.parent_id === undefined ? cur.rows[0].parent_id : body.parent_id],
        );
        await audit(db, t, "folder.updated", `folder:${id}`, "allow", { renamed: body.name !== undefined, moved: body.parent_id !== undefined });
        return r.rows[0];
      } catch (err) {
        folderError(err);
      }
    });
  });

  /** Borra la carpeta y sus subcarpetas. Los documentos NO se borran: quedan sin carpeta. */
  app.delete(`${base}/:id`, { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "folder");
    await tx(pool, t, async (db) => {
      const cur = await db.query("SELECT workspace_id FROM folders WHERE id = $1 FOR UPDATE", [id]);
      if (!cur.rows[0]) throw notFound("folder");
      requireWorkspaceWrite(t, cur.rows[0].workspace_id);
      await db.query("DELETE FROM folders WHERE id = $1", [id]);
      await audit(db, t, "folder.deleted", `folder:${id}`);
    });
    reply.code(204);
  });

  /**
   * Mueve documentos a una carpeta (o a «sin carpeta» con folder_id null). Solo se mueven los que la persona puede
   * ver; los demás se ignoran sin revelar si existen. No toca la ACL de ningún documento.
   */
  app.post("/v1/organizations/:org/documents/move", { config: { scopes: ["documents:write"] } }, async (req) => {
    const t = req.tenant!;
    const body = MoveDocuments.parse(req.body);
    return tx(pool, t, async (db) => {
      let workspaceId: string | null = null;
      if (body.folder_id) {
        const f = await db.query("SELECT workspace_id FROM folders WHERE id = $1", [body.folder_id]);
        if (!f.rows[0]) throw notFound("folder");
        workspaceId = f.rows[0].workspace_id;
        requireWorkspaceWrite(t, workspaceId!);
      }
      const docs = await db.query(
        "SELECT id, workspace_id FROM documents WHERE id = ANY($1::uuid[]) AND status = 'active' FOR UPDATE",
        [body.document_ids],
      );
      const movable: string[] = [];
      for (const d of docs.rows) {
        if (workspaceId && d.workspace_id !== workspaceId) throw badRequest("a document can only be moved to a folder of its own workspace");
        requireWorkspaceWrite(t, d.workspace_id);
        movable.push(d.id);
      }
      if (movable.length) {
        await db.query("UPDATE documents SET folder_id = $2, folder_suggestion_dismissed_at = NULL WHERE id = ANY($1::uuid[])", [
          movable,
          body.folder_id,
        ]);
        await audit(db, t, "document.moved", `folder:${body.folder_id ?? "none"}`, "allow", { documents: movable.length });
      }
      return { moved: movable.length, folder_id: body.folder_id };
    });
  });

  /** Carpeta sugerida para cada documento sin carpeta del workspace (una por documento, o ninguna). */
  app.get("/v1/organizations/:org/documents/folder-suggestions", { config: { scopes: ["documents:read"] } }, async (req) => {
    const t = req.tenant!;
    const q = z.object({ workspace_id: z.string().uuid(), document_id: z.string().uuid().optional() }).parse(req.query);
    requireWorkspaceRead(t, q.workspace_id);
    const suggestions = await tx(pool, t, (db) => suggestFolders(db, q.workspace_id, q.document_id ? [q.document_id] : null));
    return { suggestions };
  });

  /** «No, gracias»: deja de sugerir carpeta para ese documento (hasta que se mueva). */
  app.post("/v1/organizations/:org/documents/:id/folder-suggestion/dismiss", { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "documento");
    await tx(pool, t, async (db) => {
      const d = await db.query("SELECT workspace_id FROM documents WHERE id = $1 AND status = 'active' FOR UPDATE", [id]);
      if (!d.rows[0]) throw notFound("documento");
      requireWorkspaceWrite(t, d.rows[0].workspace_id);
      await db.query("UPDATE documents SET folder_suggestion_dismissed_at = now() WHERE id = $1", [id]);
    });
    reply.code(204);
  });
}
