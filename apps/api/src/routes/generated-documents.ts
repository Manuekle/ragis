import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import type { Db } from "../db/pool.js";
import { issueInternalToken } from "../lib/auth.js";
import { ApiError, notFound } from "../lib/errors.js";
import { assertUuid, audit, tx, type TenantContext } from "../lib/tenant.js";

/**
 * Documentos generados desde el chat (ADR-034).
 *
 * El rag-engine guarda el Markdown verificado y sus citas al generarlo; aquí se lee (RLS: solo su autor) y se
 * convierte al formato pedido en el momento de descargar. Antes de entregar nada se vuelve a comprobar que los
 * documentos citados siguen siendo visibles para la persona, igual que al reabrir el historial (ADR-028): si perdió
 * el acceso a alguno, el archivo no se entrega (podría contener su contenido).
 */

const FORMATS = ["pdf", "docx", "pptx", "xlsx", "csv", "md"] as const;
const FileQuery = z.object({
  format: z.enum(FORMATS).optional(),
  disposition: z.enum(["attachment", "inline"]).default("attachment"),
});
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,80}\.(pdf|docx|pptx|xlsx|csv|md)$/;

interface Row {
  id: string;
  workspace_id: string;
  title: string;
  format: (typeof FORMATS)[number];
  kind: "report" | "presentation" | "table";
  markdown: string;
  citations: { document_id?: string | null; external?: boolean }[];
  created_at: Date;
}

async function load(db: Db, id: string): Promise<{ row: Row; redacted: boolean }> {
  const r = await db.query(
    "SELECT id, workspace_id, title, format, kind, markdown, citations, created_at FROM generated_documents WHERE id=$1",
    [id],
  );
  const row = r.rows[0] as Row | undefined;
  if (!row) throw notFound("document");
  const cited = [...new Set(row.citations.map((c) => c.document_id).filter((d): d is string => !!d))];
  // RLS sobre documents: solo vuelven los que la persona ve hoy.
  const visible = new Set<string>(
    cited.length ? (await db.query("SELECT id FROM documents WHERE id = ANY($1::uuid[]) AND status='active'", [cited])).rows.map((d) => d.id) : [],
  );
  // ADR-036: public records and web pages cited in the file are not organization documents.
  const redacted = row.citations.some((c) => !c.external && (!c.document_id || !visible.has(c.document_id)));
  return { row, redacted };
}

const unavailable = () =>
  new ApiError(410, "source_unavailable", "This file used a document you can no longer open, so it can't be opened or downloaded.");

function internalToken(deps: Deps, t: TenantContext, workspaceId: string) {
  return issueInternalToken(deps.cfg.INTERNAL_SERVICE_SECRET, {
    userId: t.userId,
    organizationId: t.organizationId,
    workspaceId,
    principals: t.principals,
    plan: t.plan.id,
    dataClass: t.dataClass,
    allowlist: t.modelAllowlist,
    maxContextTokens: t.plan.max_context_tokens,
    rerank: t.plan.rerank_enabled,
    graph: t.graphEnabled,
  });
}

export async function generatedDocumentRoutes(app: FastifyInstance, deps: Deps) {
  const { pool, rag } = deps;

  app.get("/v1/organizations/:org/generated-documents/:id", { config: { scopes: ["query"] } }, async (req) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "document");
    const { row, redacted } = await tx(pool, t, (db) => load(db, id));
    return {
      id: row.id,
      workspace_id: row.workspace_id,
      title: row.title,
      format: row.format,
      kind: row.kind,
      created_at: row.created_at,
      redacted,
      markdown: redacted ? null : row.markdown,
      citations: redacted ? null : row.citations,
    };
  });

  app.get("/v1/organizations/:org/generated-documents/:id/file", { config: { scopes: ["query"] } }, async (req, reply) => {
    const t = req.tenant!;
    const id = assertUuid((req.params as { id: string }).id, "document");
    const q = FileQuery.parse(req.query);
    // The denial is audited inside the transaction and thrown after it commits: throwing inside `tx` would roll the
    // audit row back with it.
    const { row, redacted } = await tx(pool, t, async (db) => {
      const found = await load(db, id);
      const format = q.format ?? found.row.format;
      if (found.redacted) {
        await audit(db, t, "generated_document.download", `generated_document:${id}`, "deny", { reason: "source_unavailable", format });
      } else {
        await audit(db, t, "generated_document.download", `generated_document:${id}`, "allow", { format, disposition: q.disposition });
      }
      return found;
    });
    if (redacted) throw unavailable();
    if (!rag.render) throw new ApiError(503, "render_unavailable", "Files can't be prepared right now. Try again in a moment.");
    const format = q.format ?? row.format;
    const token = await internalToken(deps, t, row.workspace_id);
    const out = await rag.render(token, {
      markdown: row.markdown,
      format,
      kind: row.kind,
      title: row.title,
      citations: row.citations,
      created: row.created_at.toISOString().slice(0, 10),
    });
    if (out.status !== 200) {
      req.log.error({ status: out.status }, "rag-engine render error");
      throw new ApiError(503, "render_failed", "Couldn't prepare the file. Try again in a moment.");
    }
    const name = out.filename && SAFE_NAME.test(out.filename) ? out.filename : `document.${format}`;
    return reply
      .header("content-type", out.contentType)
      .header("content-disposition", `${q.disposition}; filename="${name}"`)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      // Si alguien abre el archivo directamente en el navegador, no puede ejecutar nada.
      .header("content-security-policy", "sandbox; default-src 'none'")
      .send(out.data);
  });
}
