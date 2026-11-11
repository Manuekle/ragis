import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { notFound } from "../lib/errors.js";
import { assertUuid, audit, tx, type TenantContext } from "../lib/tenant.js";

/**
 * Historial de conversaciones de Ask (ADR-028).
 *
 * Privado por usuario (RLS: ni los admins lo ven). No hay scopes: las claves de servicio no acceden.
 * Cada turno guarda una instantánea de la respuesta; al leerla se vuelve a comprobar que los documentos citados
 * siguen siendo visibles para el usuario. Si alguno dejó de serlo (permiso retirado o documento borrado) el turno
 * se devuelve ocultado: el texto de la respuesta podría contener su contenido, así que no se muestra.
 */

const TITLE_MAX = 80;
const TRACE_RE = /^qry_[0-9a-f]{24}$/;
// Cursor = updated_at::text de Postgres (microsegundos), no un Date de JS, para no saltar filas al paginar.
const CURSOR_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().regex(CURSOR_RE).optional(),
});
const RenameBody = z.object({ title: z.string().trim().min(1).max(120) });

/** Solo los campos que la pantalla necesita; nada interno (tiempos, costes) pasa al historial. */
function snapshot(result: Record<string, unknown>): Record<string, unknown> {
  const keep = ["trace_id", "answer", "abstained", "abstain_reason", "citations", "retrieval_strategy", "question_class", "generation_model", "latency_ms"];
  return Object.fromEntries(keep.filter((k) => k in result).map((k) => [k, result[k]]));
}

export function conversationTitle(question: string): string {
  const flat = question.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > TITLE_MAX ? `${chars.slice(0, TITLE_MAX - 1).join("").trimEnd()}…` : flat;
}

/**
 * Guarda un turno; crea la conversación si el id es nuevo. Devuelve false si el id pertenece a otra persona
 * (indistinguible de «no existe» bajo RLS): el turno no se guarda.
 */
export async function saveConversationTurn(
  db: Db,
  t: TenantContext,
  turn: { conversationId: string; workspaceId: string; question: string; asOf?: string; result: Record<string, unknown> },
): Promise<boolean> {
  const created = await db.query(
    "INSERT INTO conversations (id, organization_id, user_id, title) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING id",
    [turn.conversationId, t.organizationId, t.userId, conversationTitle(turn.question)],
  );
  if (!created.rowCount) {
    const touched = await db.query("UPDATE conversations SET updated_at = now() WHERE id=$1", [turn.conversationId]);
    if (!touched.rowCount) return false;
  }
  const trace = typeof turn.result.trace_id === "string" && TRACE_RE.test(turn.result.trace_id) ? turn.result.trace_id : null;
  await db.query(
    `INSERT INTO conversation_turns (conversation_id, organization_id, user_id, workspace_id, question, as_of, query_run_id, result)
     VALUES ($1,$2,$3,$4,$5,$6,(SELECT id FROM query_runs WHERE id=$7),$8::jsonb)`,
    [turn.conversationId, t.organizationId, t.userId, turn.workspaceId, turn.question, turn.asOf ?? null, trace, JSON.stringify(snapshot(turn.result))],
  );
  return true;
}

interface StoredTurn {
  id: string;
  workspace_id: string;
  question: string;
  as_of: string | null;
  created_at: Date;
  result: { citations?: { document_id?: string }[] } & Record<string, unknown>;
  feedback: number | null;
}

export async function conversationRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;

  app.get("/v1/organizations/:org/conversations", async (req) => {
    const t = req.tenant!;
    const q = ListQuery.parse(req.query);
    return tx(pool, t, async (db) => {
      const r = await db.query(
        `SELECT c.id, c.title, c.created_at, c.updated_at, c.updated_at::text AS cursor,
                (SELECT count(*) FROM conversation_turns x WHERE x.conversation_id = c.id)::int AS turns
           FROM conversations c
          WHERE ($2::timestamptz IS NULL OR c.updated_at < $2::timestamptz)
          ORDER BY c.updated_at DESC, c.id
          LIMIT $1`,
        [q.limit + 1, q.before ?? null],
      );
      const page = r.rows.slice(0, q.limit);
      return {
        conversations: page.map(({ cursor: _cursor, ...c }) => c),
        next_before: r.rows.length > q.limit ? page[page.length - 1].cursor : null,
      };
    });
  });

  app.get("/v1/organizations/:org/conversations/:id", async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "conversation");
    return tx(pool, t, async (db) => {
      const c = await db.query("SELECT id, title, created_at, updated_at FROM conversations WHERE id=$1", [id]);
      if (!c.rows[0]) throw notFound("conversation");
      const rows = (
        await db.query(
          `SELECT x.id::text, x.workspace_id, x.question, x.as_of::text AS as_of, x.created_at, x.result, q.feedback
             FROM conversation_turns x LEFT JOIN query_runs q ON q.id = x.query_run_id
            WHERE x.conversation_id=$1 ORDER BY x.id`,
          [id],
        )
      ).rows as StoredTurn[];

      // RLS sobre documents: solo vuelven los que el usuario ve hoy.
      const cited = [...new Set(rows.flatMap((x) => (x.result.citations ?? []).map((ci) => ci.document_id).filter((d): d is string => !!d)))];
      const visible = new Set<string>(
        cited.length ? (await db.query("SELECT id FROM documents WHERE id = ANY($1::uuid[]) AND status='active'", [cited])).rows.map((d) => d.id) : [],
      );
      return {
        ...c.rows[0],
        turns: rows.map(({ result, ...x }) => {
          const hidden = (result.citations ?? []).some((ci) => !ci.document_id || !visible.has(ci.document_id));
          return { ...x, redacted: hidden, result: hidden ? null : result };
        }),
      };
    });
  });

  app.patch("/v1/organizations/:org/conversations/:id", async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "conversation");
    const { title } = RenameBody.parse(req.body);
    return tx(pool, t, async (db) => {
      // Renombrar no mueve la conversación en la lista: updated_at sigue siendo «último mensaje».
      const r = await db.query("UPDATE conversations SET title=$2 WHERE id=$1 RETURNING id, title", [id, title]);
      if (!r.rows[0]) throw notFound("conversation");
      return r.rows[0];
    });
  });

  app.delete("/v1/organizations/:org/conversations/:id", async (req, reply) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "conversation");
    await tx(pool, t, async (db) => {
      const r = await db.query("DELETE FROM conversations WHERE id=$1", [id]);
      if (!r.rowCount) throw notFound("conversation");
      await audit(db, t, "conversation.delete", `conversation:${id}`);
    });
    reply.code(204);
  });
}
