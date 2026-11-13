/**
 * Public records in Ask (ADR-036): official government data and the web through Croma, on request.
 *
 * The API owns the decision (organization switch, monthly limit, country) and signs it into the internal token;
 * the rag-engine holds the Croma key and plans the lookups from the question alone.
 */
import type { Db } from "../db/pool.js";

export const PUBLIC_COUNTRIES = [
  { code: "co", name: "Colombia" },
  { code: "mx", name: "Mexico" },
  { code: "pe", name: "Peru" },
  { code: "cl", name: "Chile" },
  { code: "us", name: "United States" },
  { code: "br", name: "Brazil" },
  { code: "sv", name: "El Salvador" },
  { code: "gt", name: "Guatemala" },
  { code: "bo", name: "Bolivia" },
  { code: "ve", name: "Venezuela" },
  { code: "jp", name: "Japan" },
] as const;

export const COUNTRY_CODES = PUBLIC_COUNTRIES.map((c) => c.code) as [string, ...string[]];
/** "global" in a question = worldwide only (web and global registries), no national registry. */
export const COUNTRY_CHOICES = [...COUNTRY_CODES, "global"] as [string, ...string[]];

/** Lookups one question may make (the rag-engine caps it again with CROMA_MAX_CALLS). */
export const MAX_LOOKUPS_PER_QUESTION = 2;

const ALIASES: Record<string, string> = {
  colombia: "co", mexico: "mx", "méxico": "mx", peru: "pe", "perú": "pe", chile: "cl", "united states": "us",
  "estados unidos": "us", usa: "us", us: "us", brazil: "br", brasil: "br", "el salvador": "sv", guatemala: "gt",
  bolivia: "bo", venezuela: "ve", japan: "jp", "japón": "jp", japon: "jp",
};

/** Onboarding stores the country as free text ("Colombia", "CO"); map it to a supported code or null. */
export function countryFromProfile(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim().toLowerCase();
  if ((COUNTRY_CODES as string[]).includes(v)) return v;
  return ALIASES[v] ?? ALIASES[v.normalize("NFD").replace(/[̀-ͯ]/g, "")] ?? null;
}

export interface PublicSettings {
  enabled: boolean;
  /** Explicit organization default; null = taken from the onboarding profile. */
  country: string | null;
  countryFromProfile: string | null;
  web: boolean;
  monthlyLimit: number;
  usedThisMonth: number;
}

export async function loadPublicSettings(db: Db, orgId: string): Promise<PublicSettings> {
  const r = await db.query(
    `SELECT o.public_sources_enabled AS enabled, o.public_sources_country AS country, o.public_sources_web AS web,
            o.public_sources_monthly_limit AS monthly_limit, p.country AS profile_country,
            (SELECT coalesce(sum(quantity), 0)::int FROM usage_events
              WHERE organization_id = o.id AND kind = 'public_lookups'
                AND created_at >= date_trunc('month', now())) AS used
       FROM organizations o LEFT JOIN organization_profiles p ON p.organization_id = o.id
      WHERE o.id = $1`,
    [orgId],
  );
  const row = r.rows[0] ?? {};
  return {
    enabled: row.enabled === true,
    country: row.country ?? null,
    countryFromProfile: countryFromProfile(row.profile_country),
    web: row.web !== false,
    monthlyLimit: Number(row.monthly_limit ?? 0),
    usedThisMonth: Number(row.used ?? 0),
  };
}

export const effectiveCountry = (s: PublicSettings) => s.country ?? s.countryFromProfile;
