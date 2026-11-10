import { NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const actions = new Set(["open", "document", "respond", "signed"]);
const privateHeaders = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

export async function POST(req: Request, ctx: { params: Promise<{ action: string }> }) {
  const { action } = await ctx.params;
  const authorization = req.headers.get("authorization");
  if (!actions.has(action) || !authorization || !/^Signature [A-Za-z0-9_-]{43}$/.test(authorization)) {
    return NextResponse.json({ error: { message: "Invitation not found." } }, { status: 404, headers: privateHeaders });
  }
  const body = await req.text();
  if (body.length > (action === "respond" ? 620 * 1024 : 4096)) {
    return NextResponse.json({ error: { message: "Request too large." } }, { status: 413, headers: privateHeaders });
  }
  const res = await fetch(`${API_URL}/v1/signature-guest/${action}`, {
    method: "POST",
    headers: { authorization, "user-agent": req.headers.get("user-agent") ?? "", ...(body ? { "content-type": "application/json" } : {}) },
    body: body || undefined,
    cache: "no-store",
  });
  return new NextResponse(await res.text(), { status: res.status, headers: { ...privateHeaders, "content-type": "application/json" } });
}
