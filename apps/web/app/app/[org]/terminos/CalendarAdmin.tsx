"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { api, ApiError } from "@/lib/api";
import { useT } from "@/lib/use-t";
import { DatePicker, Disclosure, Select, useConfirm } from "@/components/ui";
import { Skel } from "@/components/skeletons";
import { IconAlert, IconCalendar, IconPlus, IconTrash } from "@/components/icons";
import { forgetCalendar, loadCalendarYear, shortDay, type CalendarYear } from "./shared";

const COUNTRY_NAMES: Record<string, string> = {
  co: "Colombia", mx: "México", pe: "Perú", cl: "Chile", ar: "Argentina", ec: "Ecuador", es: "España", us: "Estados Unidos", br: "Brasil",
};

/**
 * Admins: the firm's calendar that every due date is computed with. The holidays come from the country picked here;
 * court closures (judicial vacation, Holy Week, a strike) are added by hand or from the suggestions. Every change
 * recomputes the pending deadlines on the server, and the page says how many moved.
 */
export function CalendarAdmin({ org, onChanged }: { org: string; onChanged: (message: string) => void }) {
  const t = useT();
  const id = useId();
  const confirm = useConfirm();
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [cal, setCal] = useState<CalendarYear | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ label: "", starts_on: "", ends_on: "" });

  const load = useCallback(
    (fresh = false) => {
      loadCalendarYear(org, year, fresh)
        .then((c) => {
          setCal(c);
        })
        .catch((e: Error) => setError(e.message));
    },
    [org, year],
  );
  useEffect(() => {
    load();
  }, [load]);

  const moved = (n: number) => (n === 0 ? t("No pending deadline moved.") : n === 1 ? t("1 pending deadline moved.") : t("{n} pending deadlines moved.", { n }));

  const run = async (tag: string, fn: () => Promise<{ recomputed?: number }>, done: string) => {
    setBusy(tag);
    setError(null);
    try {
      const r = await fn();
      forgetCalendar();
      load(true);
      onChanged(`${done} ${moved(r.recomputed ?? 0)}`);
      return true;
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? t("That closure is already in the calendar.") : (e as Error).message);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const addClosure = (c: { starts_on: string; ends_on: string; label: string }, tag: string) =>
    run(tag, () => api(`organizations/${org}/court-closures`, { method: "POST", body: c }), t("Closure added."));

  const submit = async () => {
    if (!form.label.trim() || !form.starts_on || !form.ends_on) return setError(t("Give the closure a name, a first day and a last day."));
    if (form.ends_on < form.starts_on) return setError(t("The last day is before the first one."));
    if (await addClosure({ label: form.label.trim(), starts_on: form.starts_on, ends_on: form.ends_on }, "add")) setForm({ label: "", starts_on: "", ends_on: "" });
  };

  return (
    <Disclosure title={t("Firm calendar")} hint={t("Holidays and court closures every due date is computed with. Only admins see this.")} icon={<IconCalendar size={16} />} id="calendar">
      {error && (
        <div className="alert" role="alert">
          <IconAlert size={16} />
          {error}
        </div>
      )}
      {!cal ? (
        <div className="stack" aria-hidden="true">
          <Skel w="40%" h={14} />
          <Skel h={80} r={12} />
        </div>
      ) : (
        <div className="dl-admin">
          <div className="dl-admin-row">
            <div className="field">
              <span className="field-label">{t("Public holidays of")}</span>
              <Select
                ariaLabel={t("Public holidays of")}
                value={cal.country}
                onChange={(v) =>
                  v !== cal.country &&
                  void run("country", () => api(`organizations/${org}/deadline-calendar`, { method: "PUT", body: { holiday_country: v } }), t("Holiday country changed."))
                }
                options={cal.countries.map((c) => ({ value: c, label: COUNTRY_NAMES[c] ?? c.toUpperCase() }))}
              />
            </div>
            <div className="field">
              <span className="field-label">{t("Year")}</span>
              <div className="row" style={{ gap: 6 }}>
                <button type="button" className="ghost small" onClick={() => setYear((y) => y - 1)} aria-label={t("Previous year")}>
                  ‹
                </button>
                <strong className="dl-year">{year}</strong>
                <button type="button" className="ghost small" onClick={() => setYear((y) => y + 1)} aria-label={t("Next year")}>
                  ›
                </button>
              </div>
            </div>
          </div>
          {cal.coverage ? (
            <p className="muted">
              {t("{n} public holidays in {year}. Holidays are loaded from {from} to {to}.", { n: cal.holidays.length, year, from: cal.coverage.from.slice(0, 4), to: cal.coverage.to.slice(0, 4) })}
            </p>
          ) : (
            <p className="notice">
              <IconAlert size={16} />
              {t("No public holidays are loaded for this country.")}
            </p>
          )}

          <h4>{t("Court closures")}</h4>
          {cal.closures.length === 0 ? (
            <p className="muted">{t("No closures yet. During a closure no working day runs, as in the judicial vacation.")}</p>
          ) : (
            <ul className="dl-closures">
              {cal.closures.map((c) => (
                <li key={c.id}>
                  <span className="dl-closure-main">
                    <strong>{c.label}</strong>
                    <small className="muted">
                      {shortDay(c.starts_on)} – {shortDay(c.ends_on)} {c.ends_on.slice(0, 4)}
                      {c.created_by_email ? ` · ${c.created_by_email}` : ""}
                    </small>
                  </span>
                  <button
                    type="button"
                    className="quiet small"
                    aria-label={t("Remove the closure {name}", { name: c.label })}
                    disabled={!!busy}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: t("Remove «{name}»?", { name: c.label }),
                          body: t("Pending deadlines are recomputed without it, so some may come due earlier."),
                          confirmLabel: t("Remove"),
                          tone: "danger",
                        })
                      )
                        void run(c.id, () => api(`organizations/${org}/court-closures/${c.id}`, { method: "DELETE" }), t("Closure removed."));
                    }}
                  >
                    <IconTrash size={15} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {cal.suggestions.length > 0 && (
            <div className="dl-suggest">
              <span className="muted">{t("Suggested for {year}:", { year })}</span>
              {cal.suggestions.map((s) => (
                <button key={s.label} type="button" className="ghost small" disabled={!!busy} aria-busy={busy === s.label} onClick={() => void addClosure(s, s.label)}>
                  <IconPlus size={14} />
                  {s.label} ({shortDay(s.starts_on)} – {shortDay(s.ends_on)})
                </button>
              ))}
            </div>
          )}

          <form
            className="dl-closure-form"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="field">
              <label htmlFor={`${id}-label`}>{t("New closure")}</label>
              <input id={`${id}-label`} value={form.label} maxLength={120} placeholder={t("e.g. Judicial strike")} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </div>
            <DatePicker value={form.starts_on} onChange={(v) => setForm({ ...form, starts_on: v })} label={t("First day")} ariaLabel={t("First day of the closure")} emptyText={t("pick a date")} />
            <DatePicker value={form.ends_on} onChange={(v) => setForm({ ...form, ends_on: v })} label={t("Last day")} ariaLabel={t("Last day of the closure")} emptyText={t("pick a date")} />
            <button type="submit" className="primary" disabled={!!busy} aria-busy={busy === "add"}>
              <IconPlus size={15} />
              {t("Add closure")}
            </button>
          </form>
        </div>
      )}
    </Disclosure>
  );
}
