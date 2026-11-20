import type { Db } from "../db/pool.js";

/**
 * Due dates of procedural deadlines (ADR-037). Pure functions over ISO dates ("YYYY-MM-DD", no time zone) plus the
 * loader of a firm's calendar.
 *
 * Rules (Colombia; the holidays are data, so another country is rows in public_holidays):
 *  - The term starts running the day after the event it runs from (art. 118 CGP).
 *  - Personal notification by email is deemed made two business days after the message was sent, and the term runs
 *    from the next day (art. 8 Ley 2213 de 2022).
 *  - Business days leave out Saturdays, Sundays, public holidays and the firm's court closures (art. 118 CGP; art. 62
 *    Ley 4 de 1913).
 *  - Calendar days count every day; months and years end on the same day number they started running on, or the last
 *    day of the month if it has no such day (art. 118 CGP; art. 59 Ley 4 de 1913).
 *  - Any term that would end on a non-working day moves to the next working day (art. 118 CGP).
 *  - A fixed date is taken as written; if it is a non-working day the computation says so, without moving it.
 */

export const UNITS = ["business_days", "calendar_days", "months", "years", "fixed"] as const;
export type Unit = (typeof UNITS)[number];
export const TRIGGER_KINDS = ["notification", "ejecutoria", "filing", "hearing", "other"] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export const DEADLINE_STATUSES = ["pending", "done", "cancelled"] as const;
export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number];

/** Time zone per holiday country, for "today" (what is overdue, when reminders go out). */
const TIME_ZONES: Record<string, string> = {
  co: "America/Bogota", mx: "America/Mexico_City", pe: "America/Lima", cl: "America/Santiago", ar: "America/Argentina/Buenos_Aires",
  ec: "America/Guayaquil", es: "Europe/Madrid", us: "America/New_York", br: "America/Sao_Paulo",
};

export interface Closure {
  starts_on: string;
  ends_on: string;
  label: string;
}

export interface Calendar {
  country: string;
  /** Holiday names by ISO day. */
  holidays: Map<string, string[]>;
  closures: Closure[];
  /** First and last day the holiday table covers for this country (null when the country has no rows). */
  coverage: { from: string; to: string } | null;
}

export interface TermInput {
  trigger_date: string;
  unit: Unit;
  amount: number | null;
  notice_by_email: boolean;
}

export type SkipReason = "holiday" | "closure";

export interface Computation {
  /** Day the notification counts as made (the trigger date, or two business days later for email notices). */
  notified_on: string;
  /** First day the term counts. */
  starts_on: string;
  /** Where the count landed before moving off a non-working day. */
  nominal_due: string;
  due_on: string;
  /** Holidays and closure days inside the counting window (weekends are only counted). */
  skipped: { day: string; reason: SkipReason; name: string }[];
  weekend_days: number;
  /** Codes the web turns into sentences: which rules applied. */
  notes: string[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function toDate(iso: string): Date {
  if (!ISO.test(iso)) throw new Error(`bad date ${iso}`);
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso) throw new Error(`bad date ${iso}`);
  return d;
}

export const isIsoDate = (value: string): boolean => {
  try {
    toDate(value);
    return true;
  } catch {
    return false;
  }
};

export function addDays(iso: string, days: number): string {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Same day number `months` later; the last day of the month when it has no such day. */
export function addMonths(iso: string, months: number): string {
  const d = toDate(iso);
  const day = d.getUTCDate();
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}

export const isWeekend = (iso: string): boolean => {
  const w = toDate(iso).getUTCDay();
  return w === 0 || w === 6;
};

export const daysBetween = (from: string, to: string): number => Math.round((toDate(to).getTime() - toDate(from).getTime()) / 86_400_000);

function closureOf(cal: Calendar, iso: string): Closure | undefined {
  return cal.closures.find((c) => c.starts_on <= iso && iso <= c.ends_on);
}

/** Why a day is not a working day, or null if it is one. */
export function nonWorking(cal: Calendar, iso: string): { reason: SkipReason | "weekend"; name: string } | null {
  const holiday = cal.holidays.get(iso);
  if (holiday?.length) return { reason: "holiday", name: holiday.join(" · ") };
  const closure = closureOf(cal, iso);
  if (closure) return { reason: "closure", name: closure.label };
  if (isWeekend(iso)) return { reason: "weekend", name: "" };
  return null;
}

export const isWorkingDay = (cal: Calendar, iso: string): boolean => nonWorking(cal, iso) === null;

export function nextWorkingDay(cal: Calendar, iso: string): string {
  let d = iso;
  for (let i = 0; i < 800 && !isWorkingDay(cal, d); i++) d = addDays(d, 1);
  return d;
}

/** The working day `n` working days after `iso` (n >= 1). */
export function addWorkingDays(cal: Calendar, iso: string, n: number): string {
  let d = iso;
  let left = n;
  for (let i = 0; left > 0 && i < 40_000; i++) {
    d = addDays(d, 1);
    if (isWorkingDay(cal, d)) left--;
  }
  return d;
}

/** The working day `n` working days before `iso`. */
export function subtractWorkingDays(cal: Calendar, iso: string, n: number): string {
  let d = iso;
  let left = n;
  for (let i = 0; left > 0 && i < 40_000; i++) {
    d = addDays(d, -1);
    if (isWorkingDay(cal, d)) left--;
  }
  return d;
}

export function computeDueDate(input: TermInput, cal: Calendar): Computation {
  const notes: string[] = [];
  const trigger = input.trigger_date;
  toDate(trigger);
  if (input.unit === "fixed") {
    const off = nonWorking(cal, trigger);
    if (off) notes.push("fixed_on_non_working_day");
    notes.push("fixed_date");
    return { notified_on: trigger, starts_on: trigger, nominal_due: trigger, due_on: trigger, skipped: [], weekend_days: 0, notes };
  }
  const amount = input.amount ?? 0;
  if (!Number.isInteger(amount) || amount < 1 || amount > 3650) throw new Error("amount out of range");

  let notified = trigger;
  if (input.notice_by_email) {
    notified = addWorkingDays(cal, trigger, 2);
    notes.push("notice_by_email");
  }
  notes.push("runs_from_next_day");
  let nominal: string;
  let starts: string;
  if (input.unit === "business_days") {
    starts = nextWorkingDay(cal, addDays(notified, 1));
    nominal = addWorkingDays(cal, notified, amount);
    notes.push("business_days");
  } else if (input.unit === "calendar_days") {
    starts = addDays(notified, 1);
    nominal = addDays(notified, amount);
    notes.push("calendar_days");
  } else {
    starts = addDays(notified, 1);
    nominal = addMonths(starts, input.unit === "months" ? amount : amount * 12);
    if (toDate(nominal).getUTCDate() !== toDate(starts).getUTCDate()) notes.push("month_end");
    notes.push(input.unit === "months" ? "months" : "years");
  }
  const due = nextWorkingDay(cal, nominal);
  if (due !== nominal) notes.push("moved_to_next_working_day");

  const skipped: Computation["skipped"] = [];
  let weekend = 0;
  for (let d = addDays(trigger, 1), i = 0; d <= due && i < 40_000; d = addDays(d, 1), i++) {
    const off = nonWorking(cal, d);
    if (!off) continue;
    if (off.reason === "weekend") weekend++;
    else skipped.push({ day: d, reason: off.reason, name: off.name });
  }
  if (cal.coverage === null || trigger < cal.coverage.from || due > cal.coverage.to) notes.push("holidays_not_loaded");
  return { notified_on: notified, starts_on: starts, nominal_due: nominal, due_on: due, skipped, weekend_days: weekend, notes };
}

/** Today in the firm's country ("YYYY-MM-DD"). */
export function todayIn(country: string, now: Date = new Date()): string {
  const tz = TIME_ZONES[country] ?? "UTC";
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Local hour in the firm's country (reminders go out from 7:00). */
export function hourIn(country: string, now: Date = new Date()): number {
  const tz = TIME_ZONES[country] ?? "UTC";
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(now));
}

export type ReminderKind = "week" | "two_days" | "due" | "overdue";

/**
 * The reminder that belongs to `today` for a pending deadline due on `due`, or null. Windows do not overlap, so a
 * deadline gets at most one reminder a day, and a deadline confirmed late gets only the reminders still ahead:
 *  week      from 7 calendar days before until the day before the two-days reminder
 *  two_days  from 2 working days before until the day before it is due
 *  due       on the due date
 *  overdue   up to 7 days after, once
 */
export function reminderFor(cal: Calendar, due: string, today: string): ReminderKind | null {
  if (today > due) return daysBetween(due, today) <= 7 ? "overdue" : null;
  if (today === due) return "due";
  const twoBefore = subtractWorkingDays(cal, due, 2);
  if (today >= twoBefore) return "two_days";
  if (today >= addDays(due, -7)) return "week";
  return null;
}

/** The firm's calendar: its country's holidays and its court closures. */
export async function loadCalendar(db: Db, organizationId: string): Promise<Calendar> {
  const org = (await db.query("SELECT holiday_country FROM organizations WHERE id = $1", [organizationId])).rows[0];
  const country = (org?.holiday_country as string | undefined) ?? "co";
  return loadCalendarFor(db, country);
}

/** Calendar for a country with the active tenant's closures (RLS scopes court_closures to app.org_id()). */
export async function loadCalendarFor(db: Db, country: string): Promise<Calendar> {
  const hol = await db.query("SELECT day::text AS day, name FROM public_holidays WHERE country = $1 ORDER BY day", [country]);
  const holidays = new Map<string, string[]>();
  for (const r of hol.rows as { day: string; name: string }[]) holidays.set(r.day, [...(holidays.get(r.day) ?? []), r.name]);
  const closures = (
    await db.query("SELECT starts_on::text AS starts_on, ends_on::text AS ends_on, label FROM court_closures ORDER BY starts_on")
  ).rows as Closure[];
  const days = [...holidays.keys()];
  const first = days[0];
  const last = days[days.length - 1];
  const coverage = first && last ? { from: `${first.slice(0, 4)}-01-01`, to: `${last.slice(0, 4)}-12-31` } : null;
  return { country, holidays, closures, coverage };
}

/**
 * Suggested court closures for Colombia that a firm can add with one click (they are not added on their own):
 * the collective judicial vacation from 20 December to 10 January (art. 146 Ley 270 de 1996) and Holy Week from
 * Monday to Wednesday (Thursday and Friday are already public holidays).
 */
export function suggestedClosures(country: string, year: number, holidays: Map<string, string[]>): Closure[] {
  if (country !== "co") return [];
  const out: Closure[] = [{ starts_on: `${year}-12-20`, ends_on: `${year + 1}-01-10`, label: `Vacancia judicial ${year}-${year + 1}` }];
  const thursday = [...holidays.entries()].find(([d, names]) => d.startsWith(`${year}-`) && names.includes("Jueves Santo"))?.[0];
  if (thursday) out.unshift({ starts_on: addDays(thursday, -3), ends_on: addDays(thursday, -1), label: `Semana Santa ${year}` });
  return out;
}

/** RFC 5545 calendar with one all-day event per deadline. */
export function toIcs(
  events: { id: string; title: string; due_on: string; description: string; url?: string }[],
  calendarName: string,
  now: Date = new Date(),
): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const fold = (line: string) => {
    // Lines longer than 75 octets are folded (RFC 5545 §3.1).
    const bytes = Buffer.from(line, "utf8");
    if (bytes.length <= 75) return line;
    const parts: string[] = [];
    let start = 0;
    while (start < bytes.length) {
      let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
      while (end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--; // never split a UTF-8 character
      parts.push(bytes.subarray(start, end).toString("utf8"));
      start = end;
    }
    return parts.join("\r\n ");
  };
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Ragis//Terminos//ES", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", `X-WR-CALNAME:${esc(calendarName)}`];
  for (const e of events) {
    const day = e.due_on.replace(/-/g, "");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${e.id}@ragis`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${day}`,
      `DTEND;VALUE=DATE:${addDays(e.due_on, 1).replace(/-/g, "")}`,
      `SUMMARY:${esc(`Vence: ${e.title}`)}`,
      `DESCRIPTION:${esc(e.description)}`,
      ...(e.url ? [`URL:${e.url}`] : []),
      "TRANSP:TRANSPARENT",
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${esc(`Vence mañana: ${e.title}`)}`,
      "TRIGGER:-P1D",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(fold).join("\r\n")}\r\n`;
}
