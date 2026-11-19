import "server-only";
import { headers } from "next/headers";

/**
 * Local-currency equivalent of the USD prices on /pricing, for people outside the US.
 *
 * Display only: every plan is still charged in USD (Polar and the order forms), and the page says
 * so. The rate comes from open.er-api.com (free, no key, about 160 currencies, updated daily) and is
 * cached for six hours; if it can't be reached the page simply shows USD.
 */

/** Country (ISO 3166-1 alpha-2) to its currency, for the countries we expect. Anything else shows USD. */
const COUNTRY_CURRENCY: Record<string, string> = {
  // Latin America
  AR: "ARS", BO: "BOB", BR: "BRL", CL: "CLP", CO: "COP", CR: "CRC", DO: "DOP", EC: "USD", GT: "GTQ", HN: "HNL",
  MX: "MXN", NI: "NIO", PA: "USD", PE: "PEN", PY: "PYG", SV: "USD", UY: "UYU", VE: "VES",
  // Europe
  AT: "EUR", BE: "EUR", CY: "EUR", DE: "EUR", EE: "EUR", ES: "EUR", FI: "EUR", FR: "EUR", GR: "EUR", HR: "EUR",
  IE: "EUR", IT: "EUR", LT: "EUR", LU: "EUR", LV: "EUR", MT: "EUR", NL: "EUR", PT: "EUR", SI: "EUR", SK: "EUR",
  GB: "GBP", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON",
  // Rest of the world
  CA: "CAD", AU: "AUD", NZ: "NZD", JP: "JPY", IN: "INR", SG: "SGD", AE: "AED", ZA: "ZAR",
};

/** The visitor's country: the CDN's geo header, then the region in Accept-Language ("es-CO"), else null. `?country=` previews one outside production. */
export async function visitorCountry(preview?: string | string[]): Promise<string | null> {
  const asked = Array.isArray(preview) ? preview[0] : preview;
  const canPreview = process.env.NODE_ENV !== "production" || process.env.VERCEL_ENV === "preview";
  if (canPreview && asked && /^[A-Za-z]{2}$/.test(asked)) return asked.toUpperCase();
  const h = await headers();
  const geo = h.get("x-vercel-ip-country") ?? h.get("cf-ipcountry");
  if (geo && /^[A-Za-z]{2}$/.test(geo) && geo !== "XX") return geo.toUpperCase();
  for (const part of (h.get("accept-language") ?? "").split(",")) {
    const region = part.trim().split(";")[0]?.split("-")[1];
    if (region && /^[A-Za-z]{2}$/.test(region)) return region.toUpperCase();
  }
  return null;
}

let cache: { at: number; rates: Record<string, number> } | null = null;
const TTL = 6 * 60 * 60 * 1000;

async function usdRates(): Promise<Record<string, number> | null> {
  if (cache && Date.now() - cache.at < TTL) return cache.rates;
  try {
    const res = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(4000), next: { revalidate: 21600 } });
    const data = (await res.json()) as { result?: string; rates?: Record<string, number> };
    if (!res.ok || data.result !== "success" || !data.rates) throw new Error(`status ${res.status}`);
    cache = { at: Date.now(), rates: data.rates };
    return cache.rates;
  } catch (err) {
    console.error("[fx] could not read exchange rates:", err instanceof Error ? err.message : err);
    return cache?.rates ?? null; // a stale rate beats none
  }
}

export type LocalCurrency = { currency: string; rate: number; country: string };

/** The visitor's currency and today's USD rate, or null when they should just see USD. */
export async function localCurrency(preview?: string | string[]): Promise<LocalCurrency | null> {
  const country = await visitorCountry(preview);
  const currency = country ? COUNTRY_CURRENCY[country] : undefined;
  if (!country || !currency || currency === "USD") return null;
  const rate = (await usdRates())?.[currency];
  return rate && Number.isFinite(rate) && rate > 0 ? { currency, rate, country } : null;
}
