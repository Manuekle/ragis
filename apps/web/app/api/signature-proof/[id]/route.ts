import { NextResponse } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:4000";
const headers = { "content-type": "application/json", "cache-control": "no-store" };

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^[a-f0-9-]{36}$/.test(id)) return NextResponse.json({ error: { message: "Verification record not found." } }, { status: 404, headers });
  const response = await fetch(`${API_URL}/v1/signature-proof/${id}`, { cache: "no-store" });
  return new NextResponse(await response.text(), { status: response.status, headers });
}
