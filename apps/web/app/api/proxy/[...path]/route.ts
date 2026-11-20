import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const COOKIE = "ragsis_session";
const SAFE_SEGMENT = /^[\w.-]+$/;

/** BFF: reenvía /api/proxy/* a la API v1 agregando el bearer desde la cookie httpOnly. */
async function forward(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!path.every((s) => SAFE_SEGMENT.test(s))) return NextResponse.json({ error: { code: "bad_path" } }, { status: 400 });
  // Defensa CSRF adicional a SameSite=strict: solo aceptar escrituras del mismo origen.
  if (req.method !== "GET") {
    const origin = req.headers.get("origin");
    const host = req.headers.get("host");
    if (origin && host && new URL(origin).host !== host) {
      return NextResponse.json({ error: { code: "csrf" } }, { status: 403 });
    }
  }
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return NextResponse.json({ error: { code: "unauthenticated" } }, { status: 401 });
  const url = new URL(req.url);
  const target = `${API_URL}/v1/${path.join("/")}${url.search}`;
  const body = req.method === "GET" || req.method === "DELETE" ? "" : await req.text();
  const init: RequestInit = {
    method: req.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(path[2] === "signatures" && req.headers.get("user-agent") ? { "user-agent": req.headers.get("user-agent")! } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      // Idempotencia de runs (ADR-022): única cabecera de cliente que se reenvía.
      ...(req.headers.get("idempotency-key") ? { "idempotency-key": req.headers.get("idempotency-key")! } : {}),
    },
    body: body || undefined,
    cache: "no-store",
  };
  const res = await fetch(target, init);
  const cacheControl = res.headers.get("cache-control");
  const type = res.headers.get("content-type") ?? "application/json";
  // Archivos (documentos generados, ADR-034): se reenvían como bytes, con su nombre y sin que el navegador adivine el tipo.
  if (res.ok && !/^application\/(problem\+)?json/.test(type)) {
    const passthrough = new Headers({ "content-type": type, "x-content-type-options": "nosniff" });
    for (const h of ["content-disposition", "cache-control", "content-security-policy"]) {
      const v = res.headers.get(h);
      if (v) passthrough.set(h, v);
    }
    return new NextResponse(await res.arrayBuffer(), { status: res.status, headers: passthrough });
  }
  const text = await res.text();
  return new NextResponse(text || null, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json", ...(cacheControl ? { "cache-control": cacheControl } : {}) },
  });
}

export { forward as GET, forward as POST, forward as DELETE, forward as PUT, forward as PATCH };
