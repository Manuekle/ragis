import type { Locale } from "@/lib/i18n";

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

/** Yearly price for a plan's monthly one, in USD: twelve months, no yearly discount. */
export const annualPrice = (monthly: number) => monthly * 12;

/** What every plan includes, listed under the plans. */
export const EVERY_PLAN = ["Answers cited to the page", "Document-level permissions", "PII redaction", "Encryption in transit and at rest", "SSO with your identity provider", "Tables, figures and scanned pages"];

/** Lowest and highest monthly starting price, in USD. */
export const PRICE_RANGE = { low: Math.min(...PLANS.map((p) => p.monthlyPrice)), high: Math.max(...PLANS.map((p) => p.monthlyPrice)) };

/** The words of each plan, EVERY_PLAN and the extra-cost labels in Spanish. Product names stay as they are. */
const PLAN_TEXT_ES = {
  team: {
    blurb: "Para un equipo o departamento que empieza.",
    additionalCost: "configuración",
    features: ["3.000 consultas / mes", "2.000 documentos · 5 GB", "50 MB por archivo · 500 páginas por documento", "Búsqueda híbrida con citas de página", "30 consultas / minuto"],
  },
  business: {
    blurb: "Para empresas medianas con muchos equipos.",
    additionalCost: "configuración",
    features: ["20.000 consultas / mes", "20.000 documentos · 50 GB", "100 MB por archivo · 2.000 páginas por documento", "Reordenación para respuestas más precisas", "Grafo de conocimiento entre documentos", "120 consultas / minuto"],
  },
  private: {
    blurb: "Una infraestructura dedicada para datos sensibles.",
    additionalCost: "infraestructura",
    features: ["200.000 consultas / mes", "200.000 documentos · 500 GB", "500 MB por archivo · 5.000 páginas por documento", "Cuenta de AWS, VPC y claves KMS dedicadas", "SLA e integraciones a medida", "600 consultas / minuto"],
  },
} as const;

const EVERY_PLAN_ES = ["Respuestas citadas con la página", "Permisos a nivel de documento", "Ocultación de datos personales (PII)", "Cifrado en tránsito y en reposo", "SSO con tu proveedor de identidad", "Tablas, figuras y páginas escaneadas"];

type Plan = (typeof PLANS)[number];
type LocalizedPlan = Omit<Plan, "blurb" | "features" | "additionalCost"> & { blurb: string; features: readonly string[]; additionalCost: string };

/** The plans with their text in a language. English is the list itself. */
export function plansFor(locale: Locale): readonly LocalizedPlan[] {
  return locale === "es" ? PLANS.map((plan) => ({ ...plan, ...PLAN_TEXT_ES[plan.id] })) : PLANS;
}

/** What every plan includes, in a language. */
export const everyPlanFor = (locale: Locale): string[] => (locale === "es" ? EVERY_PLAN_ES : EVERY_PLAN);
