# Payments with Polar

Ragis takes payments through [Polar](https://polar.sh), a merchant of record: Polar charges the
customer, files the sales tax and pays out to the organization. Two places use it, both on the
public site (`apps/web`):

| Where | What is sold | Kind |
| --- | --- | --- |
| `/pricing` | Team Cloud and Business Cloud, monthly or annual | subscription |
| `/waitlist` | Sponsor slots: Supporter, Backer, Founding partner | one-time, limited slots |

Private Cloud and Self-hosted are sold through sales and have no checkout.

> **Sponsor slots are not sold through Polar right now.** Polar's review denied payment access to the
> founding-package products (sponsorship and paid-waitlist categories), and the appeal was denied
> too. Their three products are archived, `polar-sync.mjs` does not recreate them
> (`SPONSORS_ON_POLAR = false` in `sponsors.ts`), and `/waitlist` keeps its manual flow: we email
> how to pay. The Polar pay step, webhook handling and `sponsor:*` keys described below stay in the
> code, dormant, for the day Polar agrees to sell them.

## What exists in Polar

Everything is created from the site's own price lists by `apps/web/scripts/polar-sync.mjs`, so Polar
and the pages cannot drift. Each object carries `metadata.ragis_key`; the app finds it by that key,
never by id, so the same code runs against the sandbox and the live organization.

| `ragis_key` | Product | Price |
| --- | --- | --- |
| `plan:team:monthly` / `plan:team:annual` | Ragis Team Cloud | $149 / month, $1,788 / year |
| `plan:business:monthly` / `plan:business:annual` | Ragis Business Cloud | $499 / month, $5,988 / year |
| `sponsor:supporter` | Ragis Early Access · Supporter | $49 once |
| `sponsor:backer` | Ragis Early Access · Backer | $249 once |
| `sponsor:founding` | Ragis Early Access · Founding partner | $1,500 once |

Annual is twelve months with no yearly discount, as on `/pricing` (`annualPrice` in `plans.ts`).

Seasonal offers (`lib/season.ts`) are percentage discounts **without a code**, so a customer cannot
type them in: only `POST /api/checkout` applies one, from the same season the page used to show
the price.

| `ragis_key` | Off | Duration |
| --- | --- | --- |
| `season:black-friday:monthly` | 30% | 12 monthly charges |
| `season:black-friday:annual` | 30% | the first yearly charge |
| `season:holidays:monthly` | 20% | 12 monthly charges |
| `season:holidays:annual` | 20% | the first yearly charge |

They apply to Team and Business only, and not to sponsor slots. If a season has an offer and Polar
does not have its discount, the checkout is refused rather than charging more than the page showed.

To change a price, name or description, edit `plans.ts` or `sponsors.ts` and run the script again:
it updates the existing product. A new price applies to **new** subscriptions only; existing ones
keep theirs. The sponsor products are described as founding packages (early access to the
software): Polar reviews those descriptions, and they are built from the same blurb and perks the
waitlist shows.

## Set it up

Do it first in the sandbox (`https://sandbox.polar.sh`), then repeat in production.

1. In Polar, create an organization access token (Settings → Developers) with the scopes
   `products:read`, `products:write`, `discounts:read`, `discounts:write` and `checkouts:write`.
2. Create the products and discounts (safe to run again; `--dry` only shows what it would do):

   ```bash
   cd apps/web
   POLAR_ACCESS_TOKEN=polar_oat_… POLAR_SERVER=sandbox node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/polar-sync.mjs --dry
   ```

3. Add a webhook endpoint in Polar → Settings → Webhooks:
   - URL: `https://<site>/api/polar/webhook` (locally: `polar webhook listen http://localhost:3000/api/polar/webhook`)
   - Format: Raw
   - Events: `order.paid`, `order.refunded`, `subscription.created`, `subscription.updated`,
     `subscription.active`, `subscription.canceled`, `subscription.uncanceled`,
     `subscription.revoked`, `subscription.past_due`
4. Set the environment of the web service (Vercel, or the Compose `web` service):

   ```bash
   POLAR_ACCESS_TOKEN=polar_oat_…
   POLAR_SERVER=sandbox            # production when it goes live
   POLAR_WEBHOOK_SECRET=whsec_…    # the endpoint's secret
   TURSO_DATABASE_URL=…            # the webhook stores payments here
   TURSO_AUTH_TOKEN=…
   PUBLIC_BASE_URL=https://<site>  # success and return links after paying
   ```

Without `POLAR_ACCESS_TOKEN` checkout stays off: `/pricing` sends "Get started" to sign-in and the
waitlist keeps its manual flow (a sponsor slot is confirmed by hand in the database).

## How a payment flows

**Cloud plan.** `/pricing` → `POST /api/checkout {plan, period}` → Polar checkout → `/pricing/thanks`.
Polar then sends `subscription.*` events; `api/polar/webhook` stores each subscription in the
`billing_subscriptions` table (plan, period, status, renewal date, cancel flag). That table is what
tells you whom to set a workspace up for. Nothing creates a workspace automatically yet.

**Sponsor slot.** The person joins `/waitlist` with a tier and confirms their email. Their badge
page then shows "Pay with Polar" (only to the browser that holds the badge's edit token):
`POST /api/waitlist/pay` → Polar checkout → back to the badge. On `order.paid` the webhook marks the
row `confirmed` and records the order (`waitlist.polar_order_id`). A slot is taken only by a payment,
first paid first served: if the tier fills up while someone is paying, their order is logged as
`could not take a slot` and needs a refund in Polar. A full refund (`order.refunded`) opens the slot again.

## Not done yet

- **One-time setup fee.** `/pricing` says "plus setup" and the order form carries it, but no amount
  is defined in the code, so Polar charges only the recurring price.
- **Workspace provisioning** from a paid subscription, and a customer portal link inside the app.
  Customers can already manage their plan and invoices in Polar's own portal.
- **Seat limits.** Plans are per organization, so no per-seat pricing is modelled.
