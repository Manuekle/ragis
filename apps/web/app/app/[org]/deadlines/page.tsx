import { redirect } from "next/navigation";

/** Reminder emails and .ics events link to /deadlines?d=<id> (apps/api/src/routes/deadlines.ts); the page lives at /terminos. */
export default async function DeadlinesRedirect({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { org } = await params;
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(await searchParams)) if (typeof v === "string") q.set(k, v);
  const s = q.toString();
  redirect(`/app/${encodeURIComponent(org)}/terminos${s ? `?${s}` : ""}`);
}
