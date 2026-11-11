import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Deps } from "../app.js";
import { issueInternalToken } from "../lib/auth.js";
import { ApiError, badRequest, notFound, quotaExceeded } from "../lib/errors.js";
import { audit, requireWorkspaceRead, tx, type TenantContext } from "../lib/tenant.js";
import { childSpan } from "../lib/telemetry.js";
import { saveConversationTurn } from "./conversations.js";

const QueryBody = z.object({
  question: z.string().trim().min(2).max(2000),
  as_of: z.string().date().optional(),
  top_k: z.number().int().min(1).max(8).optional(),
  // RAG-05: modo de recuperación por grafo; solo tiene efecto si el tenant tiene el grafo habilitado.
  mode: z.enum(["auto", "off", "local", "global", "hybrid"]).optional(),
  // Historial (ADR-028): uuid generado por el cliente; si viene, el turno se guarda en esa conversación.
  conversation_id: z.string().uuid().optional(),
});

export interface RagClient {
  query(token: string, body: Record<string, unknown>, headers?: Record<string, string>): Promise<{ status: number; body: unknown }>;
}

/** `timeoutMs`: un modelo local (Ollama) en una máquina cargada puede tardar más de un minuto en generar. */
export function httpRagClient(baseUrl: string, timeoutMs = 120_000): RagClient {
  return {
    async query(token, body, extra) {
      try {
        const res = await fetch(`${baseUrl}/internal/query`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(extra ?? {}) },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        return { status: res.status, body: await res.json().catch(() => ({})) };
      } catch (err) {
        // Sin esto el tiempo agotado salía como «error interno» (500) sin explicación.
        if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
          throw new ApiError(504, "rag_timeout", "The answer is taking too long. Try again in a moment.");
        }
        throw err;
      }
    },
  };
}


/**
 * Consulta RAG gobernada (cuota, rate limit, token interno firmado con los principals del tenant).
 * La reutilizan /query y el sandbox de agentes: no existe un "agente RAG" que esquive la ACL.
 */
export async function runRagQuery(
  deps: Deps,
  t: TenantContext,
  ws: string,
  body: { question: string; as_of?: string; top_k?: number; mode?: string },
  req?: FastifyRequest,
): Promise<unknown> {
  const { pool, rag, limiter, cfg } = deps;
  if (!limiter.take(`${t.organizationId}:${t.userId}`, t.plan.queries_per_minute)) {
    throw new ApiError(429, "rate_limited", "demasiadas consultas por minuto");
  }
  await tx(pool, t, async (db) => {
    const r = await db.query(
      "SELECT coalesce(sum(quantity), 0)::int AS n FROM usage_events WHERE kind='query' AND created_at >= date_trunc('month', now())",
    );
    if (r.rows[0].n >= t.plan.max_queries_month) {
      await audit(db, t, "query.blocked", `workspace:${ws}`, "deny", { reason: "monthly_quota" });
      throw quotaExceeded("cuota mensual de consultas agotada");
    }
  });

  // Los principals y el tenant los resuelve la API; el texto del usuario no puede alterarlos.
  const token = await issueInternalToken(cfg.INTERNAL_SERVICE_SECRET, {
    userId: t.userId,
    organizationId: t.organizationId,
    workspaceId: ws,
    principals: t.principals,
    plan: t.plan.id,
    dataClass: t.dataClass,
    allowlist: t.modelAllowlist,
    maxContextTokens: t.plan.max_context_tokens,
    rerank: t.plan.rerank_enabled,
    graph: t.graphEnabled,
  });
  const send = (carrier?: Record<string, string>) =>
    rag.query(token, { question: body.question, as_of: body.as_of, top_k: body.top_k, graph_mode: body.mode }, carrier);
  const res = req ? await childSpan(req, "rag-engine.query", { "ragsis.workspace_id": ws }, send) : await send();
  if (res.status === 403) throw new ApiError(403, "model_policy_violation", "no model allowed by the tenant data policy");
  if (res.status === 429) throw new ApiError(429, "budget_exceeded", "presupuesto de tokens excedido");
  if (res.status !== 200) {
    req?.log.error({ status: res.status }, "rag-engine error");
    throw new ApiError(503, "rag_unavailable", "servicio de consulta no disponible");
  }
  return res.body;
}

export async function queryRoutes(app: FastifyInstance, deps: Deps) {
  const { pool } = deps;

  app.post("/v1/organizations/:org/workspaces/:ws/query", { config: { scopes: ["query"] } }, async (req) => {
    const t = req.tenant!;
    const ws = (req.params as { ws: string }).ws;
    requireWorkspaceRead(t, ws);
    const { conversation_id: conversationId, ...body } = QueryBody.parse(req.body);
    if (conversationId && t.apiKeyId) throw badRequest("conversation history is not available for service keys");
    const result = await runRagQuery(deps, t, ws, body, req);
    if (!conversationId) return result;

    // Guardar nunca debe costarle la respuesta al usuario: si falla, se devuelve igual (sin conversation_id).
    try {
      const saved = await tx(pool, t, (db) =>
        saveConversationTurn(db, t, { conversationId, workspaceId: ws, question: body.question, asOf: body.as_of, result: result as Record<string, unknown> }),
      );
      return saved ? { ...(result as object), conversation_id: conversationId } : result;
    } catch (err) {
      req.log.error({ err }, "could not save conversation turn");
      return result;
    }
  });

  app.get("/v1/organizations/:org/query-runs/:trace", { config: { scopes: ["query"] } }, async (req) => {
    const t = req.tenant!;
    const trace = (req.params as { trace: string }).trace;
    if (!/^qry_[0-9a-f]{24}$/.test(trace)) throw notFound("consulta");
    return tx(pool, t, async (db) => {
      const r = await db.query(
        `SELECT id AS trace_id, workspace_id, question_class, strategy, generation_model, embedding_model, abstained, abstain_reason,
                latency_ms, timings, prompt_tokens, completion_tokens, cost_estimate_usd, feedback, created_at
           FROM query_runs WHERE id=$1`,
        [trace],
      );
      if (!r.rows[0]) throw notFound("consulta");
      // Solo se devuelven citas cuyos documentos siguen visibles para el usuario (RLS sobre documents).
      const c = await db.query(
        `SELECT c.ordinal AS n, c.document_id, c.version_id, c.chunk_id, c.page, d.title
           FROM citations c JOIN documents d ON d.id = c.document_id
          WHERE c.query_run_id=$1 AND d.status='active' ORDER BY c.ordinal`,
        [trace],
      );
      return { ...r.rows[0], citations: c.rows };
    });
  });

  app.post("/v1/organizations/:org/query-runs/:trace/feedback", { config: { scopes: ["query"] } }, async (req, reply) => {
    const t = req.tenant!;
    const trace = (req.params as { trace: string }).trace;
    const { value } = z.object({ value: z.union([z.literal(1), z.literal(-1)]) }).parse(req.body);
    if (!/^qry_[0-9a-f]{24}$/.test(trace)) throw notFound("consulta");
    await tx(pool, t, async (db) => {
      const r = await db.query("UPDATE query_runs SET feedback=$2 WHERE id=$1", [trace, value]);
      if (!r.rowCount) throw notFound("consulta");
    });
    reply.code(204);
  });
}
