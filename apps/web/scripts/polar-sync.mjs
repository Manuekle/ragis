#!/usr/bin/env node
// Creates (or updates) the products and discounts Ragis sells in Polar, from the site's own price
// lists: plans.ts, sponsors.ts and season.ts, through lib/polar-catalog.ts. Safe to run again: each
// object is found by metadata.ragis_key, so nothing is duplicated, and a changed price is updated.
//
//   POLAR_ACCESS_TOKEN=polar_oat_... POLAR_SERVER=sandbox node scripts/polar-sync.mjs [--dry]
//
// The token needs the products:read, products:write, discounts:read and discounts:write scopes.
// POLAR_SERVER is "sandbox" or "production" (default). Run it once per environment.
// `--print` only prints the catalog as JSON and needs no token.

import { annualPrice, PLANS } from "../app/(public)/pricing/plans.ts";
import { REFUND_POLICY, SPONSOR_TIERS } from "../app/(public)/waitlist/sponsors.ts";
import { BLACK_FRIDAY_PERCENT, HOLIDAYS_PERCENT } from "../lib/season.ts";
import { buildCatalog, KEY_META } from "../lib/polar-catalog.ts";

const catalog = buildCatalog({
  plans: PLANS,
  tiers: SPONSOR_TIERS,
  annualPrice,
  offers: { "black-friday": BLACK_FRIDAY_PERCENT, holidays: HOLIDAYS_PERCENT },
  refund: REFUND_POLICY,
});

if (process.argv.includes("--print")) {
  console.log(JSON.stringify(catalog, null, 2));
  process.exit(0);
}

const dry = process.argv.includes("--dry");
const token = process.env.POLAR_ACCESS_TOKEN;
if (!token) {
  console.error("Set POLAR_ACCESS_TOKEN (an organization access token from Polar > Settings > Developers).");
  process.exit(1);
}
const server = process.env.POLAR_SERVER === "sandbox" ? "sandbox" : "production";
const base = server === "sandbox" ? "https://sandbox-api.polar.sh" : "https://api.polar.sh";

async function polar(path, { method = "GET", body, query } = {}) {
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

/** Every item of a paginated list. */
async function listAll(path, query = {}) {
  const items = [];
  for (let page = 1; ; page++) {
    const res = await polar(path, { query: { ...query, page, limit: 100 } });
    items.push(...res.items);
    if (page >= res.pagination.max_page) return items;
  }
}

const byKey = (list) => new Map(list.filter((o) => o.metadata?.[KEY_META]).map((o) => [o.metadata[KEY_META], o]));

console.log(`Polar ${server}${dry ? " (dry run, nothing is written)" : ""}`);
const orgs = await polar("/v1/organizations/");
const org = process.env.POLAR_ORGANIZATION_ID ? orgs.items.find((o) => o.id === process.env.POLAR_ORGANIZATION_ID) : orgs.items[0];
if (!org) throw new Error("No organization found for this token.");
console.log(`Organization: ${org.name} (${org.slug})`);

const write = async (label, fn) => {
  console.log(`  ${dry ? "would " : ""}${label}`);
  if (!dry) await fn();
};

// ── products ──
const products = byKey(await listAll("/v1/products/", { organization_id: org.id, is_archived: false }));
for (const want of catalog.products) {
  const price = { amount_type: "fixed", price_amount: want.cents, price_currency: "usd" };
  const have = products.get(want.key);
  if (!have) {
    await write(`create product ${want.key} (${want.name}, $${want.cents / 100})`, async () => {
      const made = await polar("/v1/products/", {
        method: "POST",
        body: {
          organization_id: org.id,
          name: want.name,
          description: want.description,
          prices: [price],
          recurring_interval: want.interval,
          metadata: { [KEY_META]: want.key },
        },
      });
      products.set(want.key, made);
    });
    continue;
  }
  const current = have.prices.find((p) => p.amount_type === "fixed" && p.price_currency === "usd");
  const changes = {};
  if (current?.price_amount !== want.cents) changes.prices = [price];
  if (have.name !== want.name) changes.name = want.name;
  if ((have.description ?? "") !== want.description) changes.description = want.description;
  if (Object.keys(changes).length > 0) {
    const what = [
      changes.prices && `price $${(current?.price_amount ?? 0) / 100} -> $${want.cents / 100} (new subscriptions only)`,
      changes.name && "name",
      changes.description && "description",
    ].filter(Boolean);
    await write(`update ${want.key}: ${what.join(", ")}`, () => polar(`/v1/products/${have.id}`, { method: "PATCH", body: changes }));
  } else console.log(`  ok ${want.key}`);
}

// ── discounts ──
const discounts = byKey(await listAll("/v1/discounts/", { organization_id: org.id }));
for (const want of catalog.discounts) {
  if (discounts.has(want.key)) {
    console.log(`  ok ${want.key}`);
    continue;
  }
  const ids = want.appliesTo.map((key) => products.get(key)?.id).filter(Boolean);
  if (ids.length !== want.appliesTo.length && !dry) throw new Error(`Products missing for ${want.key}`);
  await write(`create discount ${want.key} (${want.basisPoints / 100}% off, ${want.duration})`, () =>
    polar("/v1/discounts/", {
      method: "POST",
      body: {
        organization_id: org.id,
        type: "percentage",
        name: want.name,
        basis_points: want.basisPoints,
        duration: want.duration,
        ...(want.months ? { duration_in_months: want.months } : {}),
        products: ids,
        // No code: only our server applies it (lib/season.ts decides when), customers cannot type it in.
        metadata: { [KEY_META]: want.key },
      },
    }),
  );
}
console.log("Done.");
