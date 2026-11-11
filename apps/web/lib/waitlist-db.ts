import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createClient, type Client } from "@libsql/client/web";
import { EARLY_ACCESS } from "@/app/(public)/waitlist/sponsors";
import type { BadgeTheme, PublicBadge } from "@/lib/badge";

/**
 * Waitlist storage in Turso (TURSO_DATABASE_URL + TURSO_AUTH_TOKEN). One table: a row per
 * email, with what the person joined for. A sponsor request starts as `pending`; setting it to
 * `confirmed` (after payment) is what takes a slot on the page:
 *
 *   UPDATE waitlist SET status = 'confirmed' WHERE email = 'someone@company.com';
 */

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS waitlist (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    company TEXT NOT NULL DEFAULT '',
    interest TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed')),
    created_at TEXT NOT NULL DEFAULT (${NOW}),
    updated_at TEXT NOT NULL DEFAULT (${NOW})
  )`,
  "CREATE INDEX IF NOT EXISTS waitlist_confirmed ON waitlist (interest) WHERE status = 'confirmed'",
  // One badge per sign-up (lib/badge.ts). Public by slug; the edit token is only ever stored hashed.
  `CREATE TABLE IF NOT EXISTS waitlist_badges (
    id INTEGER PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    waitlist_id INTEGER NOT NULL REFERENCES waitlist (id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    company TEXT NOT NULL DEFAULT '',
    domain TEXT,
    theme TEXT,
    edit_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (${NOW}),
    updated_at TEXT NOT NULL DEFAULT (${NOW})
  )`,
  "CREATE INDEX IF NOT EXISTS waitlist_badges_waitlist ON waitlist_badges (waitlist_id)",
  // A logo the owner uploaded for their badge: one PNG, already checked and sized by the API.
  `CREATE TABLE IF NOT EXISTS waitlist_badge_logos (
    badge_id INTEGER PRIMARY KEY REFERENCES waitlist_badges (id) ON DELETE CASCADE,
    bytes BLOB NOT NULL,
    fill INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (${NOW})
  )`,
  // Sign-ups waiting for the person to open the link we emailed them. One per email: asking again
  // replaces the link. Only the hash of the link's token is kept. A row moves to `waitlist` when
  // the link is opened, so `waitlist` only ever holds addresses someone proved they can read.
  `CREATE TABLE IF NOT EXISTS waitlist_pending (
    email TEXT PRIMARY KEY,
    company TEXT NOT NULL DEFAULT '',
    interest TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (${NOW})
  )`,
];

/**
 * Tables made before badges followed the app's light and dark looks have no `theme` column (they
 * have an unused `color` one instead). SQLite can't add a column only when it is missing, so the
 * "already there" error is the expected answer on every start but the first.
 */
async function migrate(c: Client): Promise<void> {
  await c.batch(SCHEMA, "write");
  await c.execute("ALTER TABLE waitlist_badges ADD COLUMN theme TEXT").catch((err) => {
    if (!/duplicate column/i.test(err instanceof Error ? err.message : String(err))) throw err;
  });
}

let client: Client | null | undefined;
let schema: Promise<unknown> | undefined;

/** The client with the table in place, or null when Turso is not configured. */
async function db(): Promise<Client | null> {
  if (client === undefined) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    client = url && authToken ? createClient({ url, authToken }) : null;
  }
  if (!client) return null;
  // Created once per server process; a failed attempt is retried on the next call.
  schema ??= migrate(client).catch((err) => {
    schema = undefined;
    throw err;
  });
  await schema;
  return client;
}

export type WaitlistEntry = { email: string; company: string; interest: string };

/** joined: a new place on the list. changed: the email was already on it and now asks for something else. exists: nothing new. */
export type SignUp = "joined" | "changed" | "exists";

/**
 * Saves a sign-up. An email holds one place on the list and one badge: sending it again never
 * makes a second one. If it asks for something different this time (early access before, a
 * sponsor tier now), the request is updated; a confirmed sponsor is left as is.
 * Returns null when Turso is not configured.
 */
export async function saveWaitlistEntry({ email, company, interest }: WaitlistEntry, badge?: NewBadge): Promise<SignUp | null> {
  const c = await db();
  if (!c) return null;
  // The email is unique in the table, so two requests at once can't both get the place.
  const added = await c.execute({
    sql: "INSERT INTO waitlist (email, company, interest) VALUES (?, ?, ?) ON CONFLICT (email) DO NOTHING",
    args: [email, company, interest],
  });
  if (added.rowsAffected === 1) {
    // The badge comes after its row, so there is never a badge without one.
    if (badge)
      await c.execute({
        sql: `INSERT INTO waitlist_badges (slug, waitlist_id, company, domain, edit_hash)
              SELECT ?, id, ?, ?, ? FROM waitlist WHERE email = ?`,
        args: [badge.slug, company, badge.domain, hashToken(badge.editToken), email],
      });
    return "joined";
  }
  const changed = await c.execute({
    sql: `UPDATE waitlist SET
            interest = ?,
            company = CASE WHEN ? <> '' THEN ? ELSE company END,
            updated_at = ${NOW}
          WHERE email = ? AND status = 'pending' AND interest <> ?`,
    args: [interest, company, company, email, interest],
  });
  return changed.rowsAffected === 1 ? "changed" : "exists";
}

// ── badges ──

/**
 * A badge is made once, when an email first joins. Only the person who submitted the form then
 * gets the edit token.
 */
export type NewBadge = { slug: string; domain: string | null; editToken: string };

const SLUG_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

export function newBadge(domain: string | null): NewBadge {
  const bytes = randomBytes(10);
  const slug = Array.from(bytes, (b) => SLUG_ALPHABET[b % SLUG_ALPHABET.length]).join("");
  return { slug, domain, editToken: randomBytes(24).toString("base64url") };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ── confirming the email ──

/** How long a confirmation link works, and how soon another one can be sent to the same address. */
const LINK_HOURS = 24;
const RESEND_SECONDS = 60;

/**
 * Starts a sign-up that needs its email confirmed: keeps what was asked and returns the token
 * that goes in the emailed link. Asking again for the same email replaces the earlier link.
 * With `cooldown`, a second request within a minute returns "wait" and changes nothing, so the
 * form can't be used to flood someone's inbox. Returns null when Turso is not configured.
 */
export async function requestConfirmation({ email, company, interest }: WaitlistEntry, cooldown: boolean): Promise<{ token: string } | "wait" | null> {
  const c = await db();
  if (!c) return null;
  if (cooldown) {
    const recent = await c.execute({
      sql: "SELECT 1 FROM waitlist_pending WHERE email = ? AND (julianday('now') - julianday(created_at)) * 86400 < ?",
      args: [email, RESEND_SECONDS],
    });
    if (recent.rows.length > 0) return "wait";
  }
  const token = randomBytes(24).toString("base64url");
  await c.execute({
    sql: `INSERT INTO waitlist_pending (email, company, interest, token_hash) VALUES (?, ?, ?, ?)
          ON CONFLICT (email) DO UPDATE SET company = excluded.company, interest = excluded.interest, token_hash = excluded.token_hash, created_at = ${NOW}`,
    args: [email, company, interest, hashToken(token)],
  });
  return { token };
}

/** Forgets a pending sign-up whose email could not be sent, so the person can try again at once. */
export async function dropConfirmation(email: string): Promise<void> {
  const c = await db();
  await c?.execute({ sql: "DELETE FROM waitlist_pending WHERE email = ?", args: [email] });
}

export type Confirmed = { result: SignUp; email: string; interest: string; badge: PublicBadge | null; editToken: string | null };

/**
 * The link was opened: the sign-up becomes a place on the list. The token works once and for a
 * day. Whoever opens it has shown the address is theirs, so they also get the key to its badge:
 * a new badge for a new place, or, when the email was already on the list, a fresh key to the
 * badge it already has (the key handed out before stops working). `makeBadge` builds the new
 * badge for an email. Returns "expired" for a link that is unknown, used or too old, and null
 * when Turso is not configured.
 */
export async function confirmSignUp(token: string, makeBadge: (email: string) => NewBadge): Promise<Confirmed | "expired" | null> {
  const c = await db();
  if (!c) return null;
  const hash = hashToken(token);
  const rs = await c.execute({
    sql: "SELECT email, company, interest, (julianday('now') - julianday(created_at)) * 24 AS hours FROM waitlist_pending WHERE token_hash = ?",
    args: [hash],
  });
  const row = rs.rows[0];
  // Taking the row out is what uses the link up: of two requests at once, only one gets it.
  const taken = await c.execute({ sql: "DELETE FROM waitlist_pending WHERE token_hash = ?", args: [hash] });
  if (!row || taken.rowsAffected !== 1 || Number(row.hours) > LINK_HOURS) return "expired";

  const entry = { email: String(row.email), company: String(row.company ?? ""), interest: String(row.interest) };
  const badge = makeBadge(entry.email);
  const result = (await saveWaitlistEntry(entry, badge)) ?? "exists";
  let slug = badge.slug;
  if (result !== "joined") {
    // Already on the list: hand over its badge (the first one, if older sign-ups left several).
    const own = await c.execute({
      sql: "SELECT b.slug FROM waitlist_badges b JOIN waitlist w ON w.id = b.waitlist_id WHERE w.email = ? ORDER BY b.id LIMIT 1",
      args: [entry.email],
    });
    if (own.rows[0]) {
      slug = String(own.rows[0].slug);
      await c.execute({ sql: "UPDATE waitlist_badges SET edit_hash = ? WHERE slug = ?", args: [hashToken(badge.editToken), slug] });
    } else
      await c.execute({
        sql: `INSERT INTO waitlist_badges (slug, waitlist_id, company, domain, edit_hash)
              SELECT ?, id, company, ?, ? FROM waitlist WHERE email = ?`,
        args: [badge.slug, badge.domain, hashToken(badge.editToken), entry.email],
      });
  }
  // The badge is a bonus: if it can't be read back the place still counts.
  const saved = await findBadge(slug).catch(() => null);
  return { result, email: entry.email, interest: entry.interest, badge: saved && publicBadge(saved), editToken: saved ? badge.editToken : null };
}

type BadgeRow = PublicBadge & { domain: string | null };

const BADGE_SELECT = `SELECT b.id, b.slug, b.name, b.company, b.domain, b.theme, b.created_at, b.updated_at, w.interest, w.status,
    l.updated_at AS logo_at, l.fill AS logo_fill
  FROM waitlist_badges b JOIN waitlist w ON w.id = b.waitlist_id LEFT JOIN waitlist_badge_logos l ON l.badge_id = b.id`;

function toBadge(row: Record<string, unknown>): BadgeRow {
  const slug = String(row.slug);
  const domain = row.domain ? String(row.domain) : null;
  // An uploaded logo wins over the company's icon. Its URL changes with each upload, so browsers
  // and the 3D texture never keep showing the one before.
  const logoAt = row.logo_at ? String(row.logo_at) : null;
  const logo = `/api/waitlist/badge/${slug}/logo`;
  return {
    slug,
    number: Number(row.id),
    name: String(row.name ?? ""),
    company: String(row.company ?? ""),
    theme: row.theme === "light" || row.theme === "dark" ? row.theme : null,
    // A sponsor tier shows only once the slot is paid and confirmed.
    tier: row.status === "confirmed" ? String(row.interest) : EARLY_ACCESS,
    logoUrl: logoAt ? `${logo}?v=${encodeURIComponent(logoAt)}` : domain ? logo : null,
    ownLogo: Boolean(logoAt),
    logoFill: Boolean(logoAt) && Number(row.logo_fill) === 1,
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    domain,
  };
}

/** A badge by its public slug, with the company domain (server only). Null when not found or no database. */
export async function findBadge(slug: string): Promise<BadgeRow | null> {
  const c = await db();
  if (!c) return null;
  const rs = await c.execute({ sql: `${BADGE_SELECT} WHERE b.slug = ?`, args: [slug] });
  return rs.rows[0] ? toBadge(rs.rows[0] as Record<string, unknown>) : null;
}

/** Strips the server-only fields. */
export function publicBadge({ domain: _domain, ...badge }: BadgeRow): PublicBadge {
  return badge;
}

export type BadgeChanges = { name?: string; company?: string; theme?: BadgeTheme };

/** The badge's row id when `token` is the one handed out at sign-up; "forbidden" when it is not; null when there is no such badge. */
async function ownedBadge(c: Client, slug: string, token: string): Promise<number | "forbidden" | null> {
  const rs = await c.execute({ sql: "SELECT id, edit_hash FROM waitlist_badges WHERE slug = ?", args: [slug] });
  const stored = rs.rows[0]?.edit_hash;
  if (typeof stored !== "string") return null;
  const given = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(stored, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return "forbidden";
  return Number(rs.rows[0].id);
}

async function readPublic(slug: string): Promise<PublicBadge | null> {
  const badge = await findBadge(slug);
  return badge && publicBadge(badge);
}

/**
 * Applies the owner's changes. Returns the updated badge, "forbidden" when the token does not
 * match, or null when the badge does not exist.
 */
export async function updateBadge(slug: string, token: string, changes: BadgeChanges): Promise<PublicBadge | "forbidden" | null> {
  const c = await db();
  if (!c) return null;
  const id = await ownedBadge(c, slug, token);
  if (typeof id !== "number") return id;

  const sets: string[] = [];
  const args: string[] = [];
  for (const key of ["name", "company", "theme"] as const) {
    const value = changes[key];
    if (value === undefined) continue;
    sets.push(`${key} = ?`);
    args.push(value);
  }
  if (sets.length > 0) await c.execute({ sql: `UPDATE waitlist_badges SET ${sets.join(", ")}, updated_at = ${NOW} WHERE id = ?`, args: [...args, id] });
  return readPublic(slug);
}

/**
 * Stores the owner's logo (PNG bytes, already checked by the API), replacing the one before, or
 * removes it when `png` is null: the badge then goes back to the company's own icon, if any.
 * `fill` says the picture is a solid square that should cover its tile. Same answers as updateBadge.
 */
export async function setBadgeLogo(slug: string, token: string, png: Uint8Array | null, fill = false): Promise<PublicBadge | "forbidden" | null> {
  const c = await db();
  if (!c) return null;
  const id = await ownedBadge(c, slug, token);
  if (typeof id !== "number") return id;
  // The badge's own date moves too: it versions the share image.
  const touch = { sql: `UPDATE waitlist_badges SET updated_at = ${NOW} WHERE id = ?`, args: [id] };
  const write = png
    ? {
        sql: `INSERT INTO waitlist_badge_logos (badge_id, bytes, fill) VALUES (?, ?, ?)
              ON CONFLICT (badge_id) DO UPDATE SET bytes = excluded.bytes, fill = excluded.fill, updated_at = ${NOW}`,
        args: [id, png, fill ? 1 : 0],
      }
    : { sql: "DELETE FROM waitlist_badge_logos WHERE badge_id = ?", args: [id] };
  await c.batch([write, touch], "write");
  return readPublic(slug);
}

/** The logo the owner uploaded for this badge (PNG), or null when they did not upload one. */
export async function findBadgeLogo(slug: string): Promise<ArrayBuffer | null> {
  const c = await db();
  if (!c) return null;
  const rs = await c.execute({
    sql: "SELECT l.bytes FROM waitlist_badge_logos l JOIN waitlist_badges b ON b.id = l.badge_id WHERE b.slug = ?",
    args: [slug],
  });
  const bytes = rs.rows[0]?.bytes;
  return bytes instanceof ArrayBuffer ? bytes : null;
}

const SLOTS_TTL_MS = 60_000;
let slots: { at: number; taken: Record<string, number> } | undefined;

/** Confirmed sponsors per tier id. Cached for a minute so a page view does not cost a query. */
export async function takenSlots(): Promise<Record<string, number>> {
  if (slots && Date.now() - slots.at < SLOTS_TTL_MS) return slots.taken;
  const c = await db();
  if (!c) return {};
  const rs = await c.execute("SELECT interest, COUNT(*) AS n FROM waitlist WHERE status = 'confirmed' GROUP BY interest");
  const taken: Record<string, number> = {};
  for (const row of rs.rows) taken[String(row.interest)] = Number(row.n);
  slots = { at: Date.now(), taken };
  return taken;
}
