import { NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

/**
 * Enlace compartido público (ADR-023). Sin sesión: la API valida token (hash), caducidad y revocación, audita el
 * acceso y responde con una URL prefirmada de 60 s. Aquí solo se reenvía la redirección o se muestra el motivo.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return page(404, "This link doesn't exist.");
  const res = await fetch(`${API_URL}/v1/shares/access/${token}`, { redirect: "manual", cache: "no-store" });
  const location = res.headers.get("location");
  if (res.status === 302 && location) return NextResponse.redirect(location, { headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  if (res.status === 410) return page(410, "This link expired or was revoked. Ask the sender for a new one.");
  return page(404, "This link doesn't exist.");
}

function page(status: number, message: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Shared document</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,-apple-system,sans-serif;background:#eeeef0;color:#18181b}@media (prefers-color-scheme:dark){body{background:#111113;color:#ededef}}main{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}</style></head>
<body><main><h1>Shared document</h1><p>${message}</p></main></body></html>`;
  return new NextResponse(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer" } });
}
