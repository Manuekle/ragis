/** Webhooks HMAC de la simulación de desarrollo del hito F. */
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Config } from "../config.js";

export type EnvelopeStatus = "SENT" | "DELIVERED" | "COMPLETED" | "DECLINED" | "VOIDED";

export interface ProviderEvent {
  eventId: string;
  externalId: string;
  status: EnvelopeStatus;
  occurredAt: string;
}

export type ESignProvider = LocalProvider | { readonly name: "native" | "disabled" };

const header = (h: Record<string, string | string[] | undefined>, name: string) => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

// ---------------------------------------------------------------- local (desarrollo)
export const LOCAL_TOLERANCE_MS = 5 * 60_000;

export class LocalProvider {
  readonly name = "local" as const;
  constructor(private readonly secret: string) {}

  async createDraft(): Promise<{ externalId: string }> {
    return { externalId: `local_${randomUUID()}` };
  }

  /** Firma un evento como lo haría el proveedor (timestamp + HMAC-SHA256 sobre `${ts}.${raw}`). */
  sign(event: ProviderEvent, now = Date.now()): { raw: Buffer; headers: Record<string, string> } {
    const raw = Buffer.from(JSON.stringify({ event_id: event.eventId, envelope_id: event.externalId, status: event.status, occurred_at: event.occurredAt }));
    const ts = String(now);
    const sig = createHmac("sha256", this.secret).update(`${ts}.`).update(raw).digest("hex");
    return { raw, headers: { "x-ragsis-timestamp": ts, "x-ragsis-signature": sig, "content-type": "application/json" } };
  }

  verify(raw: Buffer, headers: Record<string, string | string[] | undefined>): boolean {
    const ts = header(headers, "x-ragsis-timestamp");
    const sig = header(headers, "x-ragsis-signature");
    if (!ts || !sig || !/^\d{10,16}$/.test(ts)) return false;
    // Protección de replay: además del dedupe por event_id, el evento debe ser reciente.
    if (Math.abs(Date.now() - Number(ts)) > LOCAL_TOLERANCE_MS) return false;
    const expected = createHmac("sha256", this.secret).update(`${ts}.`).update(raw).digest("hex");
    return safeEqual(expected, sig);
  }

  parse(raw: Buffer): ProviderEvent | null {
    try {
      const j = JSON.parse(raw.toString("utf8"));
      if (typeof j.event_id !== "string" || typeof j.envelope_id !== "string") return null;
      if (!["SENT", "DELIVERED", "COMPLETED", "DECLINED", "VOIDED"].includes(j.status)) return null;
      return { eventId: j.event_id, externalId: j.envelope_id, status: j.status, occurredAt: String(j.occurred_at ?? new Date().toISOString()) };
    } catch {
      return null;
    }
  }

}

export function createESignProvider(cfg: Config): ESignProvider {
  if (cfg.ESIGN_PROVIDER !== "local") return { name: cfg.ESIGN_PROVIDER };
  const secret = cfg.ESIGN_WEBHOOK_SECRET ?? createHash("sha256").update(`${cfg.INTERNAL_SERVICE_SECRET}:esign-local`).digest("hex");
  return new LocalProvider(secret);
}
