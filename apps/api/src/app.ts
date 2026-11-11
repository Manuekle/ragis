import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import Fastify, { type FastifyInstance } from "fastify";
import type pg from "pg";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { isApiKeyToken, keyAllows, resolveApiKey, tenantFromApiKey } from "./lib/apikeys.js";
import { Authenticator, type AuthUser } from "./lib/auth.js";
import type { Queue, Storage } from "./lib/aws.js";
import { ApiError } from "./lib/errors.js";
import { RateLimiter } from "./lib/ratelimit.js";
import { resolveTenant, type TenantContext } from "./lib/tenant.js";
import { registerTracing } from "./lib/telemetry.js";
import { documentRoutes } from "./routes/documents.js";
import { orgRoutes } from "./routes/orgs.js";
import { queryRoutes, type RagClient } from "./routes/query.js";
import { conversationRoutes } from "./routes/conversations.js";
import { onboardingRoutes } from "./routes/onboarding.js";
import { agentRoutes } from "./routes/agents.js";
import { workflowRoutes } from "./routes/workflows.js";
import { WorkflowRunner } from "./lib/workflow-runner.js";
import { createESignProvider, type ESignProvider } from "./lib/esign.js";
import { externalRoutes } from "./routes/external.js";
import { nativeSignatureRoutes } from "./routes/signatures.js";
import { createSignatureMailer, type SignatureMailer } from "./lib/signature-email.js";
import { deliverSignatureInvites } from "./lib/signature-native.js";
import { ConnectorService, type ServiceOptions } from "./lib/connectors/service.js";
import { connectorRoutes } from "./routes/connectors.js";
import { z } from "zod";

declare module "fastify" {
  interface FastifyContextConfig {
    /** Scopes de clave de servicio que habilitan la ruta. Sin scopes: la ruta no acepta claves. */
    scopes?: string[];
  }
  interface FastifyInstance {
    /** Orquestador de workflows (ADR-022). */
    workflows: WorkflowRunner;
    /** Conectores y su planificador (CON-01, ADR-025). */
    connectors: ConnectorService;
  }
  interface FastifyRequest {
    user?: AuthUser;
    tenant?: TenantContext;
  }
}

export interface Deps {
  cfg: Config;
  pool: pg.Pool;
  storage: Storage;
  queue: Queue;
  rag: RagClient;
  limiter: RateLimiter;
  /** Proveedor de firma electrónica (ADR-023). */
  esign: ESignProvider;
  signatureMailer?: SignatureMailer;
}

export async function buildApp(
  deps: Omit<Deps, "limiter" | "esign"> & { limiter?: RateLimiter; esign?: ESignProvider; connectorOptions?: ServiceOptions },
): Promise<FastifyInstance> {
  const full: Deps = { ...deps, limiter: deps.limiter ?? new RateLimiter(), esign: deps.esign ?? createESignProvider(deps.cfg), signatureMailer: deps.signatureMailer ?? createSignatureMailer(deps.cfg) };
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      redact: ["req.headers.authorization", "req.headers.cookie", "req.body.question"],
    },
    bodyLimit: 1024 * 1024,
    trustProxy: true,
    genReqId: () => `req_${crypto.randomUUID()}`,
  });
  const auth = new Authenticator(full.cfg, full.pool);

  registerTracing(app);
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: full.cfg.CORS_ORIGINS.split(",").map((s) => s.trim()), credentials: true });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: { code: "validation_error", message: "invalid request", details: err.issues } });
    }
    if (err instanceof ApiError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.code(status).send({ error: { code: "bad_request", message: (err as Error).message } });
    }
    req.log.error({ err }, "unhandled error");
    return reply.code(500).send({ error: { code: "internal_error", message: "error interno", request_id: req.id } });
  });

  app.get("/healthz", async () => {
    await full.pool.query("SELECT 1");
    return { status: "ok" };
  });

  if (full.cfg.AUTH_MODE === "dev") {
    // Solo entornos locales/dev: emite un JWT de prueba. Prohibido en producción (ver config.ts).
    app.post("/v1/auth/dev-login", async (req) => {
      const body = z.object({ email: z.string().email(), name: z.string().max(120).optional(), mfa: z.boolean().optional() }).parse(req.body);
      return { token: await auth.issueDevToken(body.email, body.name, body.mfa), token_type: "Bearer", expires_in: 8 * 3600 };
    });
  }

  app.addHook("preHandler", async (req) => {
    const url = req.routeOptions.url ?? "";
    if (!url.startsWith("/v1/") || url === "/v1/auth/dev-login") return;
    // Públicas: webhooks firmados por el proveedor (HMAC) y enlaces compartidos (token con caducidad).
    if (url.startsWith("/v1/webhooks/") || url.startsWith("/v1/shares/access/") || url.startsWith("/v1/signature-guest/") || url.startsWith("/v1/signature-proof/")) return;
    const org = (req.params as { org?: string } | undefined)?.org;
    if (isApiKeyToken(req.headers.authorization)) {
      const key = await resolveApiKey(full.pool, req.headers.authorization!);
      const required = req.routeOptions.config?.scopes;
      if (!required?.length) throw new ApiError(403, "forbidden", "ruta no disponible para claves de servicio");
      if (!keyAllows(key, required)) throw new ApiError(403, "insufficient_scope", `requiere scope: ${required.join(" | ")}`);
      // La clave pertenece a un único tenant: cualquier otra organización es inexistente para ella.
      if (!org || org !== key.organizationId) throw new ApiError(404, "not_found", "organization not found");
      req.tenant = await tenantFromApiKey(full.pool, key);
      return;
    }
    req.user = await auth.verify(req.headers.authorization);
    if (org) req.tenant = await resolveTenant(full.pool, req.user.userId, org);
  });

  await orgRoutes(app, full);
  await documentRoutes(app, full);
  await queryRoutes(app, full);
  await conversationRoutes(app, full);
  await onboardingRoutes(app, full);
  await agentRoutes(app, full);
  const runner = new WorkflowRunner(full);
  app.decorate("workflows", runner);
  app.addHook("onClose", async () => runner.drain());
  await workflowRoutes(app, full, runner);
  await externalRoutes(app, full, runner);
  await nativeSignatureRoutes(app, full, runner);
  const connectors = new ConnectorService(full, deps.connectorOptions);
  app.decorate("connectors", connectors);
  app.addHook("onClose", async () => connectors.stop());
  await connectorRoutes(app, full, connectors);
  if (full.signatureMailer) {
    let delivery: Promise<void> | undefined;
    const tick = () => {
      delivery ??= deliverSignatureInvites(full)
        .catch(() => app.log.error("signature invitation delivery worker failed"))
        .finally(() => { delivery = undefined; });
    };
    const interval = setInterval(tick, 5_000);
    interval.unref();
    app.addHook("onClose", async () => {
      clearInterval(interval);
      await delivery;
    });
  }
  return app;
}
