/**
 * Trazas OpenTelemetry (OTLP/HTTP). Se activan solo si OTEL_EXPORTER_OTLP_ENDPOINT está definido.
 * Instrumentación manual: un span por request (ruta plantilla, nunca URL con datos), atributos de tenant
 * pseudónimos (UUID) y propagación W3C traceparent hacia rag-engine y el worker (vía SQS).
 * Nunca se registran preguntas, respuestas, emails ni tokens.
 */
import { context, propagation, SpanKind, SpanStatusCode, trace, type Context, type Span } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { FastifyInstance, FastifyRequest } from "fastify";

let provider: NodeTracerProvider | null = null;

export function initTelemetry(serviceName = "ragsis-api"): boolean {
  if (provider || !process.env.OTEL_EXPORTER_OTLP_ENDPOINT) return !!provider;
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME ?? serviceName,
      "deployment.environment.name": process.env.RAGSIS_ENV ?? "local",
    }),
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
  });
  provider.register(); // AsyncLocalStorage + propagador W3C (traceparent/baggage)
  return true;
}

export async function shutdownTelemetry(): Promise<void> {
  await provider?.shutdown();
  provider = null;
}

const tracer = () => trace.getTracer("ragsis-api");

declare module "fastify" {
  interface FastifyRequest {
    otel?: { span: Span; ctx: Context };
  }
}

/** Hooks Fastify: span SERVER por request con el padre recibido en traceparent (si viene del BFF). */
export function registerTracing(app: FastifyInstance): void {
  app.addHook("onRequest", async (req) => {
    const parent = propagation.extract(context.active(), req.headers);
    const route = req.routeOptions.url ?? "unmatched";
    const span = tracer().startSpan(`${req.method} ${route}`, {
      kind: SpanKind.SERVER,
      attributes: { "http.request.method": req.method, "http.route": route, "ragsis.request_id": req.id },
    }, parent);
    req.otel = { span, ctx: trace.setSpan(parent, span) };
  });
  app.addHook("preHandler", async (req) => {
    const t = req.tenant;
    if (req.otel && t) {
      req.otel.span.setAttributes({
        "ragsis.org_id": t.organizationId,
        "ragsis.user_id": t.userId,
        "ragsis.auth": t.apiKeyId ? "api_key" : "user",
      });
    }
  });
  app.addHook("onResponse", async (req, reply) => {
    const s = req.otel?.span;
    if (!s) return;
    s.setAttribute("http.response.status_code", reply.statusCode);
    if (reply.statusCode >= 500) s.setStatus({ code: SpanStatusCode.ERROR });
    s.end();
  });
  app.addHook("onError", async (req, _reply, err) => {
    // Solo el tipo/código: los mensajes pueden contener datos de cliente.
    req.otel?.span.setAttribute("error.type", (err as { code?: string }).code ?? err.name);
  });
}

/** Ejecuta `fn` dentro de un span hijo del request y devuelve el carrier W3C para propagar. */
export async function childSpan<T>(
  req: FastifyRequest,
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: (carrier: Record<string, string>) => Promise<T>,
): Promise<T> {
  const parentCtx = req.otel?.ctx ?? context.active();
  const span = tracer().startSpan(name, { kind: SpanKind.CLIENT, attributes: attrs }, parentCtx);
  const carrier: Record<string, string> = {};
  propagation.inject(trace.setSpan(parentCtx, span), carrier);
  try {
    return await fn(carrier);
  } catch (err) {
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute("error.type", (err as Error).name);
    throw err;
  } finally {
    span.end();
  }
}

/** traceparent del request actual (para mensajes SQS). */
export function currentTraceparent(req: FastifyRequest): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(req.otel?.ctx ?? context.active(), carrier);
  return carrier.traceparent;
}
