"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { dateLocale } from "@/lib/i18n";
import { tNow, useT } from "@/lib/use-t";
import { IconAlert, IconCalendar } from "@/components/icons";

/* Procedural deadlines ("términos", ADR-038): types as the API returns them and the words the page shows. */

export type Unit = "business_days" | "calendar_days" | "months" | "years" | "fixed";
export type TriggerKind = "notification" | "ejecutoria" | "filing" | "hearing" | "other";
export type View = "overdue" | "week" | "month" | "open" | "done";
export type DeadlineState = "overdue" | "today" | "soon" | "upcoming" | "done" | "cancelled";

export const UNITS: Unit[] = ["business_days", "calendar_days", "months", "years", "fixed"];
export const TRIGGER_KINDS: TriggerKind[] = ["notification", "ejecutoria", "filing", "hearing", "other"];

export interface Computation {
  notified_on: string;
  starts_on: string;
  nominal_due: string;
  due_on: string;
  skipped: { day: string; reason: "holiday" | "closure"; name: string }[];
  weekend_days: number;
  notes: string[];
}

export interface Deadline {
  id: string;
  workspace_id: string;
  workspace_name: string;
  title: string;
  trigger_kind: TriggerKind;
  trigger_date: string;
  notice_by_email: boolean;
  unit: Unit;
  amount: number | null;
  due_on: string;
  computation: Computation;
  legal_basis: string;
  responsible_id: string;
  responsible_email: string | null;
  responsible_name: string | null;
  status: "pending" | "done" | "cancelled";
  notes: string;
  document_id: string | null;
  document_title: string | null;
  version_id: string | null;
  page: number | null;
  quote: string | null;
  confirmed_by_email: string | null;
  confirmed_by_name: string | null;
  confirmed_at: string | null;
  closed_by_email: string | null;
  closed_at: string | null;
  created_at: string;
  state: DeadlineState;
  days_left: number | null;
  can_edit: boolean;
}

export interface DeadlineList {
  today: string;
  country: string;
  reminders_enabled: boolean;
  counts: { overdue: number; week: number; month: number; open: number; candidates: number };
  deadlines: Deadline[];
}

export interface Candidate {
  id: string;
  workspace_id: string;
  workspace_name: string;
  document_id: string;
  document_title: string;
  version_id: string;
  version_no: number;
  page: number | null;
  quote: string;
  amount: number | null;
  unit: Unit;
  unit_assumed: boolean;
  trigger_hint: TriggerKind | string;
  trigger_date: string | null;
  legal_basis: string;
  title: string;
  status: string;
  created_at: string;
  can_confirm: boolean;
  suggested_due: string | null;
}

export interface Person {
  id: string;
  email: string;
  display_name: string | null;
}

export const UNIT_COPY: Record<Unit, string> = {
  business_days: "working days",
  calendar_days: "calendar days",
  months: "months",
  years: "years",
  fixed: "Fixed date",
};
export const TRIGGER_COPY: Record<TriggerKind, string> = {
  notification: "Notification",
  ejecutoria: "Ejecutoria",
  filing: "Filing",
  hearing: "Hearing",
  other: "Other event",
};
export const triggerWord = (k: string) => tNow(TRIGGER_COPY[k as TriggerKind] ?? TRIGGER_COPY.other);

export const personName = (p: { display_name?: string | null; email?: string | null } | null | undefined) => p?.display_name || p?.email || "—";

/** "2027-02-03" read as a calendar day (no time zone shift). */
const day = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};
/** "mié, 3 feb 2027": lawyers check the weekday of a due date at a glance. */
export const longDate = (iso: string) => day(iso).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short", year: "numeric" });
export const shortDay = (iso: string) => day(iso).toLocaleDateString(dateLocale(), { weekday: "short", day: "numeric", month: "short" });
export const isWeekend = (iso: string) => [0, 6].includes(day(iso).getDay());
/** The calendar day after `iso` ("YYYY-MM-DD"). */
export const addDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** "10 working days from the notification of 5 Nov 2026", or "Fixed date". */
export function termSummary(d: { unit: Unit; amount: number | null; trigger_kind: string; trigger_date: string; notice_by_email?: boolean }) {
  if (d.unit === "fixed") return tNow("Fixed date");
  return tNow("{amount} {unit} from {date} ({kind})", {
    amount: d.amount ?? "?",
    unit: tNow(UNIT_COPY[d.unit]),
    kind: triggerWord(d.trigger_kind).toLowerCase(),
    date: longDate(d.trigger_date),
  }) + (d.notice_by_email ? tNow(" (by email)") : "");
}

/** Where a deadline stands: days left in working days, days overdue in calendar days (as the API computes them). */
export function StandingBadge({ state, daysLeft }: { state: DeadlineState; daysLeft: number | null }) {
  const t = useT();
  const n = Math.abs(daysLeft ?? 0);
  const [tone, label] =
    state === "overdue"
      ? ["err", n === 1 ? t("Overdue by 1 day") : t("Overdue by {n} days", { n })]
      : state === "today"
        ? ["err", t("Ends today")]
        : state === "soon"
          ? ["warn", n === 1 ? t("1 working day left") : t("{n} working days left", { n })]
          : state === "upcoming"
            ? ["", n === 1 ? t("1 working day left") : t("{n} working days left", { n })]
            : state === "done"
              ? ["ok", t("Met")]
              : ["", t("Withdrawn")];
  return (
    <span className={`badge${tone ? ` ${tone}` : ""}`}>
      <span className="dot" aria-hidden="true" />
      {label}
    </span>
  );
}

/** Why a day is not a working day, from the firm's calendar of that year (holidays and court closures). */
export interface CalendarYear {
  country: string;
  countries: string[];
  year: number;
  coverage: { from: string; to: string } | null;
  holidays: { day: string; name: string; basis: string | null }[];
  closures: { id: string; starts_on: string; ends_on: string; label: string; created_by_email: string | null }[];
  suggestions: { starts_on: string; ends_on: string; label: string }[];
  can_edit: boolean;
}
const yearCache = new Map<string, Promise<CalendarYear>>();
export function loadCalendarYear(org: string, year: number, fresh = false): Promise<CalendarYear> {
  const key = `${org}:${year}`;
  if (fresh || !yearCache.has(key)) {
    const p = api<CalendarYear>(`organizations/${org}/deadline-calendar?year=${year}`);
    p.catch(() => yearCache.delete(key));
    yearCache.set(key, p);
  }
  return yearCache.get(key)!;
}
export const forgetCalendar = () => yearCache.clear();

function useNonWorkingReason(org: string, iso: string | null) {
  const [reason, setReason] = useState<string | null>(null);
  useEffect(() => {
    setReason(null);
    if (!iso) return;
    let live = true;
    loadCalendarYear(org, Number(iso.slice(0, 4)))
      .then((c) => {
        if (!live) return;
        const closure = c.closures.find((x) => x.starts_on <= iso && iso <= x.ends_on);
        const holiday = c.holidays.filter((h) => h.day === iso).map((h) => h.name);
        const why = [
          holiday.length ? tNow("it is a public holiday ({name})", { name: holiday.join(" · ") }) : null,
          closure ? tNow("it falls inside the court closure «{name}»", { name: closure.label }) : null,
          !holiday.length && !closure && isWeekend(iso) ? tNow("it is a Saturday or a Sunday") : null,
        ].filter(Boolean);
        if (why.length) setReason(why.join(tNow(" and ")));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [org, iso]);
  return reason;
}

/**
 * The breakdown of a due date in words: which rules applied (the API's `notes`) and every day left out or kept in.
 * For calendar days, months and years the non-working days inside the window count like any other day; only the ones
 * after the nominal end moved the date, and the copy says which is which.
 */
export function ComputationView({ c, unit, org, country }: { c: Computation; unit: Unit; org: string; country?: string }) {
  const t = useT();
  const has = (n: string) => c.notes.includes(n);
  const fixedOff = has("fixed_on_non_working_day");
  const reason = useNonWorkingReason(org, fixedOff ? c.due_on : null);
  const sentences: string[] = [];
  if (has("fixed_date")) sentences.push(t("A fixed date is taken as written in the document: nothing is counted and it is never moved."));
  if (has("notice_by_email"))
    sentences.push(t("Notified by email: the notice counts as made two working days after it was sent, on {date} (art. 8 Ley 2213 de 2022).", { date: longDate(c.notified_on) }));
  if (has("runs_from_next_day")) sentences.push(t("The term starts running the day after, on {date} (art. 118 CGP).", { date: longDate(c.starts_on) }));
  if (has("business_days")) sentences.push(t("Counted in working days: Saturdays, Sundays, public holidays and court closures are left out."));
  if (has("calendar_days")) sentences.push(t("Counted in calendar days: every day counts, weekends and holidays included."));
  if (has("months")) sentences.push(t("Counted in months: it ends on the same day number it started running on (art. 118 CGP)."));
  if (has("years")) sentences.push(t("Counted in years: it ends on the same day and month it started running on (art. 118 CGP)."));
  if (has("month_end")) sentences.push(t("The final month has no such day, so it ends on that month's last day."));
  if (has("moved_to_next_working_day"))
    sentences.push(t("The count ends on {nominal}, which is not a working day, so it moves to the next working day: {due} (art. 118 CGP).", { nominal: longDate(c.nominal_due), due: longDate(c.due_on) }));

  const calendarCount = unit === "calendar_days" || unit === "months" || unit === "years";
  const inside = calendarCount ? c.skipped.filter((s) => s.day <= c.nominal_due) : [];
  const moved = calendarCount ? c.skipped.filter((s) => s.day > c.nominal_due) : [];
  // Consecutive days with the same reason read as one range ("dom, 20 dic – jue, 24 dic · Vacancia judicial").
  const runs = (days: Computation["skipped"]) =>
    days.reduce<{ from: string; to: string; reason: string; name: string }[]>((acc, s) => {
      const last = acc[acc.length - 1];
      if (last && last.reason === s.reason && last.name === s.name && addDay(last.to) === s.day) last.to = s.day;
      else acc.push({ from: s.day, to: s.day, reason: s.reason, name: s.name });
      return acc;
    }, []);
  const skippedLines = (days: Computation["skipped"]) =>
    runs(days).map((r) => (
      <li key={r.from}>
        <span className="when">{r.from === r.to ? shortDay(r.from) : `${shortDay(r.from)} – ${shortDay(r.to)}`}</span>
        <span className="why">{r.reason === "closure" ? t("Court closure · {name}", { name: r.name }) : r.name}</span>
      </li>
    ));

  return (
    <div className="dl-calc">
      {fixedOff && (
        <div className="alert" role="alert">
          <IconAlert size={16} />
          <span>
            <strong>{t("{date} is not a working day", { date: longDate(c.due_on) })}</strong>
            {reason ? ` — ${reason}.` : "."}{" "}
            {t("A fixed date is not moved: check it against the document, and with the court if needed, before relying on it.")}
          </span>
        </div>
      )}
      {has("holidays_not_loaded") && (
        <div className="notice" role="status">
          <IconAlert size={16} />
          <span>{t("The holidays of {country} are not loaded for every year this term spans, so holidays in that range were not left out. Check the date by hand.", { country: (country ?? "").toUpperCase() || "—" })}</span>
        </div>
      )}
      <div className="dl-due">
        <IconCalendar size={16} />
        <span>{t("Due on")}</span>
        <strong>{longDate(c.due_on)}</strong>
      </div>
      {sentences.length > 0 && (
        <ul className="dl-notes">
          {sentences.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}
      {unit === "business_days" && (c.skipped.length > 0 || c.weekend_days > 0) && (
        <div className="dl-skipped">
          <h4>{t("Days left out of the count")}</h4>
          {c.skipped.length > 0 && <ul>{skippedLines(c.skipped)}</ul>}
          {c.weekend_days > 0 && <p className="muted">{c.weekend_days === 1 ? t("Also 1 Saturday or Sunday.") : t("Also {n} Saturdays and Sundays.", { n: c.weekend_days })}</p>}
        </div>
      )}
      {calendarCount && inside.length > 0 && (
        <div className="dl-skipped">
          <h4>{t("Non-working days inside the window")}</h4>
          <p className="muted">{t("They count like any other day: they did not move the due date.")}</p>
          <ul>{skippedLines(inside)}</ul>
        </div>
      )}
      {calendarCount && moved.length > 0 && (
        <div className="dl-skipped">
          <h4>{t("Non-working days that moved the due date")}</h4>
          <ul>{skippedLines(moved)}</ul>
        </div>
      )}
    </div>
  );
}
