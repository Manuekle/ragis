// Seasonal touches for the public site: which background the landing's horizon shows, and the
// holiday discount on /pricing. Edit the dates and percentages here; nothing else needs to change.
//
//   Black Friday to Cyber Monday   30% off the first year, ASCII horizon as usual
//   1 December to 6 January        20% off the first year, snow on the landing
//
// Dates are calendar days in UTC. Override for a demo or a launch with RAGSIS_SEASON
// (black-friday | holidays | none). Outside production, `?season=` on the page does the same, so
// a preview can be checked without waiting for December.

export type SeasonId = "none" | "black-friday" | "holidays";

export type Offer = {
  /** Shown in the banner and the note: "Black Friday offer", "Holiday offer". */
  name: string;
  /** Percent off, applied to self-serve plans for the first year. */
  percent: number;
  /** Last day the offer is valid, as YYYY-MM-DD (UTC). */
  ends: string;
};

export type Season = {
  id: SeasonId;
  /** Snow on the landing instead of the ASCII horizon. */
  snow: boolean;
  offer: Offer | null;
};

const BLACK_FRIDAY_PERCENT = 30;
const HOLIDAYS_PERCENT = 20;

const day = (year: number, month: number, date: number) => new Date(Date.UTC(year, month, date));
const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Black Friday: the day after the fourth Thursday of November. */
function blackFriday(year: number) {
  const first = day(year, 10, 1).getUTCDay(); // 0 = Sunday
  const firstThursday = 1 + ((4 - first + 7) % 7);
  return day(year, 10, firstThursday + 21 + 1);
}

function blackFridaySeason(year: number): Season {
  const cyberMonday = day(year, 10, blackFriday(year).getUTCDate() + 3);
  return { id: "black-friday", snow: false, offer: { name: "Black Friday offer", percent: BLACK_FRIDAY_PERCENT, ends: iso(cyberMonday) } };
}

function holidaysSeason(endYear: number): Season {
  return { id: "holidays", snow: true, offer: { name: "Holiday offer", percent: HOLIDAYS_PERCENT, ends: iso(day(endYear, 0, 6)) } };
}

const NONE: Season = { id: "none", snow: false, offer: null };

/** The season on a given date. Black Friday wins where it overlaps the start of December. */
export function seasonAt(now: Date): Season {
  const today = day(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const year = today.getUTCFullYear();
  const bf = blackFridaySeason(year);
  if (today >= blackFriday(year) && iso(today) <= bf.offer!.ends) return bf;
  if (today.getUTCMonth() === 11) return holidaysSeason(year + 1);
  if (today.getUTCMonth() === 0 && today.getUTCDate() <= 6) return holidaysSeason(year);
  return NONE;
}

function byId(id: string, now: Date): Season | null {
  const year = now.getUTCFullYear();
  if (id === "none") return NONE;
  if (id === "black-friday") return blackFridaySeason(now.getUTCMonth() === 0 ? year - 1 : year);
  if (id === "holidays") return holidaysSeason(now.getUTCMonth() === 0 ? year : year + 1);
  return null;
}

/** Today's season, after the RAGSIS_SEASON override and, outside production, a `?season=` preview. */
export function currentSeason(preview?: string | string[]): Season {
  const now = new Date();
  const forced = process.env.RAGSIS_SEASON?.trim();
  if (forced) return byId(forced, now) ?? seasonAt(now);
  const canPreview = process.env.NODE_ENV !== "production" || process.env.VERCEL_ENV === "preview";
  const asked = Array.isArray(preview) ? preview[0] : preview;
  if (canPreview && asked) return byId(asked, now) ?? seasonAt(now);
  return seasonAt(now);
}

/** "January 6", for "until January 6". */
export function offerEnds(offer: Offer) {
  return new Date(`${offer.ends}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
}
