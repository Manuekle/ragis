import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors.js";
import { assertUuid, audit, isAdmin, requireWorkspaceWrite, tx, type TenantContext } from "../lib/tenant.js";

/**
 * Expedientes (ADR-037): un registro de la firma por cliente y caso que agrupa documentos de cualquier espacio.
 *
 * Nunca amplía el acceso: vincular un documento no toca su ACL, y todo listado o conteo de documentos se lee bajo la
 * RLS de `documents` y solo en los espacios donde la persona es miembro (lo mismo que puede abrir en la biblioteca).
 * Los datos del expediente (cliente, contraparte, radicado) son visibles para todo miembro de la organización.
 */

export const MATTER_STATUSES = ["active", "on_hold", "closed", "archived"] as const;

const text = (max: number) => z.string().trim().max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

const MatterFields = z.object({
  title: text(160).optional(),
  client_name: text(160).min(1),
  counterparty: optionalText(160),
  case_number: optionalText(60),
  court: optionalText(160),
  stage: optionalText(80),
  owner_id: z.string().uuid().nullish(),
  status: z.enum(MATTER_STATUSES).optional(),
});
const UpdateMatter = z
  .object({
    title: text(160).min(1).optional(),
    client_name: text(160).min(1).optional(),
    counterparty: optionalText(160).optional(),
    case_number: optionalText(60).optional(),
    court: optionalText(160).optional(),
    stage: optionalText(80).optional(),
    owner_id: z.string().uuid().nullable().optional(),
    status: z.enum(MATTER_STATUSES).optional(),
  })
  .refine((b) => Object.values(b).some((v) => v !== undefined), "nothing to change");
const LinkDocuments = z.object({
  document_ids: z.array(z.string().uuid()).min(1).max(200),
  matter_id: z.string().uuid().nullable(),
});
const FromFolder = MatterFields.extend({ folder_id: z.string().uuid(), include_subfolders: z.boolean().default(true) });

/** «Parra Rosas — D-16.857» cuando no se da un título: el cliente y, si lo hay, el radicado. */
export function defaultMatterTitle(client: string, caseNumber: string | null | undefined): string {
  return (caseNumber ? `${client} — ${caseNumber}` : client).slice(0, 160);
}

function matterError(err: unknown): never {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e.code === "23505") throw conflict("an expediente with that filing number already exists");
  if (e.code === "23514") throw badRequest(e.message ?? "invalid expediente");
  throw err;
}

function requireMatterWrite(t: TenantContext): void {
  if (t.role === "viewer") throw forbidden("rol viewer es de solo lectura");
}

/** Espacios donde la persona es miembro: el único lugar donde se cuentan o listan documentos de un expediente. */
export const memberWorkspaces = (t: TenantContext) => [...t.workspaces.keys()];

async function checkOwner(db: Db, t: TenantContext, ownerId: string | null | undefined): Promise<void> {
  if (!ownerId) return;
  const r = await db.query("SELECT 1 FROM memberships WHERE organization_id = $1 AND user_id = $2 AND status = 'active'", [
    t.organizationId,
    ownerId,
  ]);
  if (!r.rowCount) throw badRequest("the responsible person must be a member of the organization");
}

const SELECT_MATTER = `
  SELECT m.id, m.title, m.client_name, m.counterparty, m.case_number, m.court, m.stage, m.status, m.created_by,
         m.created_at, m.updated_at,
         CASE WHEN m.owner_id IS NULL THEN NULL
              ELSE json_build_object('id', m.owner_id, 'name', coalesce(u.display_name, u.email, 'Former member')) END AS owner,
         (SELECT count(*)::int FROM documents d
           WHERE d.matter_id = m.id AND d.status = 'active' AND d.workspace_id = ANY($1::uuid[])) AS document_count,
         (SELECT max(d.updated_at) FROM documents d
           WHERE d.matter_id = m.id AND d.status = 'active' AND d.workspace_id = ANY($1::uuid[])) AS last_document_at
    FROM matters m LEFT JOIN users u ON u.id = m.owner_id`;

async function loadMatter(db: Db, t: TenantContext, id: string) {
  const r = await db.query(`${SELECT_MATTER} WHERE m.id = $2`, [memberWorkspaces(t), id]);
  if (!r.rows[0]) throw notFound("expediente");
  return r.rows[0];
}

const canDelete = (t: TenantContext, m: { created_by: string | null }) => isAdmin(t) || m.created_by === t.userId;

/**
 * Vincula documentos a un expediente (o los desvincula con null). Solo cuenta los que la persona puede ver (RLS) en
 * espacios donde puede editar; los demás se ignoran sin revelar si existen. `skipLinkedElsewhere` deja quietos los que
 * ya están en otro expediente (al convertir una carpeta).
 */
async function linkDocuments(
  db: Db,
  t: TenantContext,
  ids: string[],
  matterId: string | null,
  opts: { skipLinkedElsewhere?: boolean } = {},
): Promise<{ linked: number; skipped: number }> {
  const docs = await db.query(
    "SELECT id, workspace_id, matter_id FROM documents WHERE id = ANY($1::uuid[]) AND status = 'active' FOR UPDATE",
    [ids],
  );
  const movable: string[] = [];
  let skipped = 0;
  for (const d of docs.rows) {
    if (!t.workspaces.has(d.workspace_id)) continue;
    requireWorkspaceWrite(t, d.workspace_id);
    if (opts.skipLinkedElsewhere && d.matter_id && d.matter_id !== matterId) {
      skipped++;
      continue;
    }
    movable.push(d.id);
  }
  if (movable.length) {
    await db.query("UPDATE documents SET matter_id = $2 WHERE id = ANY($1::uuid[])", [movable, matterId]);
    await audit(db, t, "document.matter_linked", `matter:${matterId ?? "none"}`, "allow", { documents: movable.length });
  }
  return { linked: movable.length, skipped };
}

export async function matterRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;
  const base = "/v1/organizations/:org/matters";

  app.get(base, { config: { scopes: ["documents:read"] } }, async (req) => {
    const t = req.tenant!;
    const q = z
      .object({ status: z.enum(MATTER_STATUSES).optional(), q: z.string().trim().max(200).optional() })
      .parse(req.query);
    return tx(pool, t, async (db) => {
      const r = await db.query(
        `${SELECT_MATTER}
          WHERE ($2::text IS NULL OR m.status = $2)
            AND ($3::text IS NULL OR m.title ILIKE '%' || $3 || '%' OR m.client_name ILIKE '%' || $3 || '%'
                 OR m.case_number ILIKE '%' || $3 || '%' OR m.counterparty ILIKE '%' || $3 || '%'
                 OR m.court ILIKE '%' || $3 || '%')
          ORDER BY lower(m.client_name), lower(m.title)
          LIMIT 500`,
        [memberWorkspaces(t), q.status ?? null, q.q || null],
      );
      // Para elegir responsable: los miembros activos (nombre visible), sin exigir rol de admin.
      const people = await db.query(
        `SELECT u.id, coalesce(u.display_name, u.email) AS name FROM memberships m JOIN users u ON u.id = m.user_id
          WHERE m.organization_id = $1 AND m.status = 'active' ORDER BY lower(coalesce(u.display_name, u.email))`,
        [t.organizationId],
      );
      return {
        matters: r.rows.map((m) => ({ ...m, can_delete: canDelete(t, m) })),
        can_edit: t.role !== "viewer",
        people: people.rows,
      };
    });
  });

  app.post(base, { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    requireMatterWrite(t);
    const body = MatterFields.parse(req.body);
    const row = await tx(pool, t, async (db) => {
      await checkOwner(db, t, body.owner_id);
      const id = await insertMatter(db, t, body);
      await audit(db, t, "matter.created", `matter:${id}`);
      return loadMatter(db, t, id);
    });
    reply.code(201);
    return { ...row, can_delete: true };
  });

  /** El expediente y sus documentos visibles de todos los espacios donde la persona es miembro. */
  app.get(`${base}/:id`, { config: { scopes: ["documents:read"] } }, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "expediente");
    return tx(pool, t, async (db) => {
      const m = await loadMatter(db, t, id);
      const docs = await db.query(
        `SELECT d.id, d.title, d.workspace_id, w.name AS workspace_name, d.folder_id, f.name AS folder_name,
                d.created_at, d.updated_at, d.current_version_id, lv.id AS latest_version_id, lv.filename, lv.content_type,
                lv.status AS latest_status
           FROM documents d
           JOIN workspaces w ON w.id = d.workspace_id
           LEFT JOIN folders f ON f.id = d.folder_id
           LEFT JOIN LATERAL (SELECT * FROM document_versions v WHERE v.document_id = d.id ORDER BY version_no DESC LIMIT 1) lv ON true
          WHERE d.matter_id = $1 AND d.status = 'active' AND d.workspace_id = ANY($2::uuid[])
          ORDER BY d.updated_at DESC
          LIMIT 500`,
        [id, memberWorkspaces(t)],
      );
      return { ...m, can_edit: t.role !== "viewer", can_delete: canDelete(t, m), documents: docs.rows };
    });
  });

  app.patch(`${base}/:id`, { config: { scopes: ["documents:write"] } }, async (req) => {
    const t = req.tenant!;
    requireMatterWrite(t);
    const id = assertUuid((req.params as { id: string }).id, "expediente");
    const body = UpdateMatter.parse(req.body);
    return tx(pool, t, async (db) => {
      const cur = await db.query("SELECT id FROM matters WHERE id = $1 FOR UPDATE", [id]);
      if (!cur.rows[0]) throw notFound("expediente");
      await checkOwner(db, t, body.owner_id);
      const sets: string[] = [];
      const values: unknown[] = [id];
      for (const key of ["title", "client_name", "counterparty", "case_number", "court", "stage", "owner_id", "status"] as const) {
        if (body[key] === undefined) continue;
        values.push(body[key]);
        sets.push(`${key} = $${values.length}`);
      }
      try {
        await db.query(`UPDATE matters SET ${sets.join(", ")} WHERE id = $1`, values);
      } catch (err) {
        matterError(err);
      }
      await audit(db, t, "matter.updated", `matter:${id}`, "allow", { fields: Object.keys(body).filter((k) => body[k as keyof typeof body] !== undefined) });
      const m = await loadMatter(db, t, id);
      return { ...m, can_delete: canDelete(t, m) };
    });
  });

  /** Borra el expediente. Sus documentos NO se borran: quedan sin expediente (también los que esta persona no ve). */
  app.delete(`${base}/:id`, { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    requireMatterWrite(t);
    const id = assertUuid((req.params as { id: string }).id, "expediente");
    await tx(pool, t, async (db) => {
      const cur = await db.query("SELECT created_by FROM matters WHERE id = $1 FOR UPDATE", [id]);
      if (!cur.rows[0]) throw notFound("expediente");
      if (!canDelete(t, cur.rows[0])) throw forbidden("only an admin or whoever created the expediente can delete it");
      await db.query("DELETE FROM matters WHERE id = $1", [id]);
      await audit(db, t, "matter.deleted", `matter:${id}`);
    });
    reply.code(204);
  });

  /** Vincula documentos a un expediente, o los desvincula con matter_id null. No toca la ACL de ningún documento. */
  app.post("/v1/organizations/:org/documents/matter", { config: { scopes: ["documents:write"] } }, async (req) => {
    const t = req.tenant!;
    const body = LinkDocuments.parse(req.body);
    return tx(pool, t, async (db) => {
      if (body.matter_id) {
        const m = await db.query("SELECT 1 FROM matters WHERE id = $1", [body.matter_id]);
        if (!m.rowCount) throw notFound("expediente");
      }
      const r = await linkDocuments(db, t, body.document_ids, body.matter_id);
      return { linked: r.linked, matter_id: body.matter_id };
    });
  });

  /**
   * «Convertir en expediente»: crea un expediente a partir de una carpeta y le vincula los documentos visibles de la
   * carpeta (y de sus subcarpetas). La carpeta se queda como está. Los documentos que ya estaban en otro expediente no
   * se mueven: se cuentan en `skipped`.
   */
  app.post(`${base}/from-folder`, { config: { scopes: ["documents:write"] } }, async (req, reply) => {
    const t = req.tenant!;
    requireMatterWrite(t);
    const body = FromFolder.parse(req.body);
    const out = await tx(pool, t, async (db) => {
      const f = await db.query("SELECT workspace_id, name FROM folders WHERE id = $1", [body.folder_id]);
      if (!f.rows[0]) throw notFound("folder");
      requireWorkspaceWrite(t, f.rows[0].workspace_id);
      await checkOwner(db, t, body.owner_id);
      const id = await insertMatter(db, t, { ...body, title: body.title || f.rows[0].name });
      const docs = await db.query(
        `WITH RECURSIVE tree AS (
           SELECT id FROM folders WHERE id = $1
           UNION ALL
           SELECT c.id FROM folders c JOIN tree ON c.parent_id = tree.id WHERE $2
         )
         SELECT d.id FROM documents d WHERE d.folder_id IN (SELECT id FROM tree) AND d.status = 'active'`,
        [body.folder_id, body.include_subfolders],
      );
      const r = docs.rowCount
        ? await linkDocuments(db, t, docs.rows.map((d) => d.id as string), id, { skipLinkedElsewhere: true })
        : { linked: 0, skipped: 0 };
      await audit(db, t, "matter.created", `matter:${id}`, "allow", { from_folder: body.folder_id, documents: r.linked });
      return { matter: await loadMatter(db, t, id), linked: r.linked, skipped: r.skipped };
    });
    reply.code(201);
    return { ...out, matter: { ...out.matter, can_delete: true } };
  });
}

async function insertMatter(db: Db, t: TenantContext, body: z.infer<typeof MatterFields>): Promise<string> {
  try {
    const r = await db.query(
      `INSERT INTO matters (organization_id, title, client_name, counterparty, case_number, court, stage, owner_id, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        t.organizationId,
        body.title || defaultMatterTitle(body.client_name, body.case_number),
        body.client_name,
        body.counterparty ?? null,
        body.case_number ?? null,
        body.court ?? null,
        body.stage ?? null,
        body.owner_id ?? null,
        body.status ?? "active",
        t.userId,
      ],
    );
    return r.rows[0].id as string;
  } catch (err) {
    matterError(err);
  }
}
