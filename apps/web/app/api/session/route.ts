import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const SECURE = process.env.SESSION_COOKIE_SECURE !== "false";
const COOKIE = "ragsis_session";

/** Login de desarrollo: intercambia email por JWT y lo guarda en cookie httpOnly (nunca en JS del navegador). */
export async function POST(req: Request) {
  // El login por email solo existe en AUTH_MODE=dev; con OIDC se usa /api/auth/login.
  if (process.env.AUTH_MODE === "oidc") return NextResponse.json({ error: { code: "not_found" } }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { email?: string; name?: string };
  const res = await fetch(`${API_URL}/v1/auth/dev-login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: body.email, name: body.name }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return NextResponse.json(data, { status: res.status });
  const jar = await cookies();
  jar.set(COOKIE, data.token, { httpOnly: true, secure: SECURE, sameSite: "lax", path: "/", maxAge: data.expires_in });
  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(COOKIE);
  return NextResponse.json({ ok: true });
}
