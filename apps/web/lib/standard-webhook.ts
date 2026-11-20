import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Checks the signature Polar puts on every webhook (the Standard Webhooks scheme): an HMAC-SHA256
 * of `<webhook-id>.<webhook-timestamp>.<raw body>`, sent base64 in `webhook-signature` as one or
 * more `v1,<signature>` entries.
 *
 * Polar derives the key in two ways, depending on when the endpoint's secret was made, so both
 * are tried: secrets from 8 September 2026 on are `whsec_` + base64 (the key is the decoded
 * part), older ones use the UTF-8 bytes of the whole secret string.
 *
 * `body` must be the raw text of the request, byte for byte: parsing and re-serializing it breaks
 * the signature. Deliveries older than five minutes are refused, so a captured one cannot be replayed.
 */
export function verifyStandardWebhook(secret: string, body: string, headers: { get(name: string): string | null }, now = Date.now()): boolean {
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp");
  const signatures = headers.get("webhook-signature");
  if (!secret || !id || !timestamp || !signatures) return false;

  const age = Math.abs(now / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;

  const given = signatures
    .split(" ")
    .map((entry) => entry.split(",", 2))
    .filter(([version, value]) => version === "v1" && value)
    .map(([, value]) => Buffer.from(value, "base64"));
  if (given.length === 0) return false;

  const signed = `${id}.${timestamp}.${body}`;
  const keys = [Buffer.from(secret.replace(/^whsec_/, ""), "base64"), Buffer.from(secret, "utf8")];
  return keys.some((key) => {
    const expected = createHmac("sha256", key).update(signed).digest();
    return given.some((sig) => sig.length === expected.length && timingSafeEqual(sig, expected));
  });
}
