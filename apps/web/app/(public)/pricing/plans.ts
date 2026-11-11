// Plans shown on /pricing and described in the structured data and llms.txt.
// Quotas mirror the `plans` table (db/migrations/0001_init.sql, graph_enabled from 0005).
// Prices are the commercial starting points from the master plan, section 19.
export const PLANS = [
  {
    id: "team",
    name: "Team Cloud",
    monthlyPrice: 149,
    additionalCost: "setup",
    blurb: "For a team or department getting started.",
    features: ["3,000 queries / month", "2,000 documents · 5 GB", "50 MB per file · 500 pages per document", "Hybrid search with page citations", "30 queries / minute"],
  },
  {
    id: "business",
    name: "Business Cloud",
    monthlyPrice: 499,
    additionalCost: "setup",
    blurb: "For mid-size companies across many teams.",
    featured: true,
    features: ["20,000 queries / month", "20,000 documents · 50 GB", "100 MB per file · 2,000 pages per document", "Reranking for sharper answers", "Knowledge graph across documents", "120 queries / minute"],
  },
  {
    id: "private",
    name: "Private Cloud",
    monthlyPrice: 1500,
    additionalCost: "infrastructure",
    blurb: "A dedicated stack for sensitive data.",
    contactSales: true,
    features: ["200,000 queries / month", "200,000 documents · 500 GB", "500 MB per file · 5,000 pages per document", "Dedicated AWS account, VPC and KMS keys", "SLA and custom integrations", "600 queries / minute"],
  },
] as const;

/** What every plan includes, listed under the plans. */
export const EVERY_PLAN = ["Answers cited to the page", "Document-level permissions", "PII redaction", "Encryption in transit and at rest", "SSO with your identity provider", "Tables, figures and scanned pages"];

/** Lowest and highest monthly starting price, in USD. */
export const PRICE_RANGE = { low: Math.min(...PLANS.map((p) => p.monthlyPrice)), high: Math.max(...PLANS.map((p) => p.monthlyPrice)) };
