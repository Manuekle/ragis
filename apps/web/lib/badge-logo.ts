import "server-only";
import { findBadgeLogo } from "@/lib/waitlist-db";

/**
 * Company logos for waitlist badges. The owner can upload one; until they do, the company is
 * read from the work email's domain and its icon comes from Google's public favicon service,
 * fetched here on the server so the browser only ever loads it from our own origin (a
 * cross-origin image could not be drawn into the 3D texture). Personal mail domains have no
 * company icon; the card shows initials instead.
 */

const PERSONAL_MAIL =
  /^(gmail|googlemail|outlook|hotmail|live|msn|yahoo|ymail|rocketmail|icloud|me|mac|aol|proton(mail)?|pm|gmx|mail|email|zoho|yandex|hey|fastmail|tuta(nota)?|qq|163|126|naver|daum|web|t-online|orange|free|laposte|libero|seznam|wp|o2|interia|onet|mailbox|posteo|inbox|rambler|bk|list|terra|uol|bol|telefonica|movistar|prodigy|att|comcast|verizon|sbcglobal|bellsouth|cox|charter|earthlink|juno|optonline|shaw|rogers|sympatico|btinternet|sky|virginmedia|talktalk|ntlworld|bigpond|optusnet|xtra|rediffmail|sina|sohu|aliyun|foxmail|duck)\./;

const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The company domain behind a work email, or null for personal mail and odd addresses. */
export function companyDomain(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase().replace(/^www\./, "") ?? "";
  if (!DOMAIN.test(domain) || PERSONAL_MAIL.test(domain)) return null;
  return domain;
}

export type Logo = { bytes: ArrayBuffer; type: string };

const MIN_SIZE = 48;
const MAX_BYTES = 512 * 1024;
const TTL_MS = 6 * 60 * 60 * 1000;
const cache = new Map<string, { at: number; logo: Logo | null }>();

/** Width and height of a PNG from its header, or null when the bytes are not a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * The company's icon at up to 256px, or null when there is none worth showing: Google answers
 * 404 with a generic globe for unknown sites, and an icon under 48px would look blurry on the card.
 * Results (including misses) are kept in memory for a few hours. Throws when the lookup itself
 * failed (timeout, network), which is not cached anywhere so the next request tries again.
 */
export async function fetchLogo(domain: string): Promise<Logo | null> {
  const hit = cache.get(domain);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.logo;

  let logo: Logo | null = null;
  const res = await fetch(`https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=256`, {
    signal: AbortSignal.timeout(6000),
    redirect: "follow",
  });
  const type = res.headers.get("content-type")?.split(";")[0] ?? "";
  if (res.ok && /^image\/(png|jpeg)$/.test(type)) {
    const bytes = await res.arrayBuffer();
    const width = type === "image/png" ? (pngSize(new Uint8Array(bytes))?.width ?? null) : MIN_SIZE;
    if (bytes.byteLength <= MAX_BYTES && width !== null && width >= MIN_SIZE) logo = { bytes, type };
  } else if (res.status >= 500) throw new Error(`favicon service answered ${res.status}`);

  if (cache.size > 2000) cache.clear();
  cache.set(domain, { at: Date.now(), logo });
  return logo;
}


/** The logo a badge shows: the one its owner uploaded, otherwise the company's icon. Null when there is neither. */
export async function badgeLogo(badge: { slug: string; domain: string | null }): Promise<Logo | null> {
  const own = await findBadgeLogo(badge.slug);
  if (own) return { bytes: own, type: "image/png" };
  return badge.domain ? fetchLogo(badge.domain) : null;
}
