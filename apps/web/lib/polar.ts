import "server-only";
import { isIP } from "node:net";
import { KEY_META } from "./polar-catalog";
import { verifyStandardWebhook } from "./standard-webhook";

/**
 * Polar (https://polar.sh) takes the payments: the cloud plans on /pricing and the sponsor slots
 * on /waitlist. Polar is the merchant of record, so it also charges and files the sales tax.
 *
 *   POLAR_ACCESS_TOKEN    organization access token (checkouts:write, products:read, discounts:read).
 *                         Empty = checkout is off and the pages keep their old, manual flow.
 *   POLAR_SERVER          "sandbox" or "production" (default).
 *   POLAR_WEBHOOK_SECRET  signs the events Polar sends to /api/polar/webhook.
 *
 * Products and discounts are found by `metadata.ragis_key` (lib/polar-catalog.ts), never by id, so
 * the same code runs against the sandbox and the live organization. scripts/polar-sync.mjs creates them.
 */

export const polarEnabled = () => Boolean(process.env.POLAR_ACCESS_TOKEN);

export const polarServer = () => (process.env.POLAR_SERVER === "sandbox" ? "sandbox" : "production");

/** Why a call to Polar failed, in terms the caller can act on. The message never carries the token. */
export class PolarError extends Error {
  constructor(
    message: string,
    readonly code: "api" | "missing_product" | "missing_discount",
  ) {
    super(message);
  }
}

async function api<T>(path: string, { method = "GET", body, query }: { method?: "GET" | "POST"; body?: unknown; query?: Record<string, string | number | boolean> } = {}): Promise<T> {
  const token = process.env.POLAR_ACCESS_TOKEN;
  if (!token) throw new PolarError("POLAR_ACCESS_TOKEN is not set", "api");
  const url = new URL(path, polarServer() === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh");
  for (const [name, value] of Object.entries(query ?? {})) url.searchParams.set(name, String(value));
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new PolarError(`Polar ${method} ${path} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`, "api");
  return (await res.json()) as T;
}

type Listed = { id: string; metadata?: Record<string, unknown> };
type Page = { items: Listed[]; pagination: { max_page: number } };

async function listAll(path: string, query: Record<string, string | number | boolean>): Promise<Listed[]> {
  const items: Listed[] = [];
  for (let page = 1; ; page++) {
    const res = await api<Page>(path, { query: { ...query, page, limit: 100 } });
    items.push(...res.items);
    if (page >= res.pagination.max_page) return items;
  }
}

const IDS_TTL_MS = 5 * 60_000;
let known: { at: number; products: Map<string, string>; discounts: Map<string, string> } | undefined;

/** Ids of our products and discounts by key. Cached for five minutes, so a checkout costs one extra call at most. */
async function lookup() {
  if (known && Date.now() - known.at < IDS_TTL_MS) return known;
  const [products, discounts] = await Promise.all([listAll("/v1/products/", { is_archived: false }), listAll("/v1/discounts/", {})]);
  const byKey = (list: Listed[]) => new Map(list.flatMap((item) => (typeof item.metadata?.[KEY_META] === "string" ? [[item.metadata[KEY_META] as string, item.id] as const] : [])));
  known = { at: Date.now(), products: byKey(products), discounts: byKey(discounts) };
  return known;
}

export type CheckoutRequest = {
  productKey: string;
  /**
   * A discount to apply. It fails closed: if Polar has no such discount the checkout is refused,
   * because the page already showed the discounted price and charging the full one would break that promise.
   */
  discountKey?: string;
  email?: string;
  metadata: Record<string, string>;
  successUrl: string;
  returnUrl?: string;
  /** The buyer's address (see clientIp). Polar picks the billing country, and so the tax, from it. */
  ip?: string;
};

/**
 * The visitor's public IP from the proxy's headers, or undefined when there is none (local
 * development, a private address). The checkout is created from our server, so without this Polar
 * would see the server's address and get the buyer's country, currency and tax wrong.
 */
export function clientIp(headers: Headers): string | undefined {
  const ip = (headers.get("x-forwarded-for")?.split(",")[0] ?? headers.get("x-real-ip") ?? "").trim();
  if (!isIP(ip)) return undefined;
  const local = /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || ip === "::1" || /^(fc|fd|fe80)/i.test(ip);
  return local ? undefined : ip;
}

/** Opens a Polar checkout and returns the page the buyer pays on. */
export async function createCheckout({ productKey, discountKey, email, metadata, successUrl, returnUrl, ip }: CheckoutRequest): Promise<{ url: string }> {
  let ids = await lookup();
  let product = ids.products.get(productKey);
  let discount = discountKey ? ids.discounts.get(discountKey) : undefined;
  if ((!product || (discountKey && !discount)) && Date.now() - ids.at > 30_000) {
    // Something was just added in Polar: look again once before giving up.
    known = undefined;
    ids = await lookup();
    product = ids.products.get(productKey);
    discount = discountKey ? ids.discounts.get(discountKey) : undefined;
  }
  if (!product) throw new PolarError(`No Polar product with ${KEY_META}=${productKey}. Run scripts/polar-sync.mjs.`, "missing_product");
  if (discountKey && !discount) throw new PolarError(`No Polar discount with ${KEY_META}=${discountKey}. Run scripts/polar-sync.mjs.`, "missing_discount");

  const checkout = await api<{ url: string }>("/v1/checkouts/", {
    method: "POST",
    body: {
      products: [product],
      ...(discount ? { discount_id: discount } : {}),
      ...(email ? { customer_email: email } : {}),
      metadata,
      success_url: successUrl,
      ...(returnUrl ? { return_url: returnUrl } : {}),
      ...(ip ? { customer_ip_address: ip } : {}),
    },
  });
  return { url: checkout.url };
}

/** True when `body` was signed with POLAR_WEBHOOK_SECRET (lib/standard-webhook.ts). */
export function verifyWebhook(body: string, headers: Headers): boolean {
  return verifyStandardWebhook(process.env.POLAR_WEBHOOK_SECRET?.trim() ?? "", body, headers);
}
