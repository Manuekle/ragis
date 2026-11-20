import { describe, expect, it } from "vitest";
import {
  addMonths,
  computeDueDate,
  reminderFor,
  suggestedClosures,
  todayIn,
  toIcs,
  type Calendar,
  type Closure,
} from "../src/lib/deadlines.js";

// Colombian holidays the cases below cross (same rows as migration 0023).
const HOLIDAYS: [string, string][] = [
  ["2026-04-02", "Jueves Santo"], ["2026-04-03", "Viernes Santo"], ["2026-11-02", "Todos los Santos"],
  ["2026-11-16", "Independencia de Cartagena"], ["2026-12-08", "Inmaculada Concepción"], ["2026-12-25", "Navidad"],
  ["2027-01-01", "Año Nuevo"], ["2027-01-11", "Reyes Magos"], ["2027-03-22", "San José"],
];

function cal(closures: Closure[] = []): Calendar {
  const holidays = new Map<string, string[]>();
  for (const [d, n] of HOLIDAYS) holidays.set(d, [n]);
  return { country: "co", holidays, closures, coverage: { from: "2024-01-01", to: "2032-12-31" } };
}

const VACANCY: Closure = { starts_on: "2026-12-20", ends_on: "2027-01-10", label: "Vacancia judicial 2026-2027" };

describe("computeDueDate", () => {
  it("counts business days from the day after the notification, skipping weekends and holidays", () => {
    // Notified Friday 13 Nov 2026; Monday 16 is a holiday: counting starts Tuesday 17.
    const c = computeDueDate({ trigger_date: "2026-11-13", unit: "business_days", amount: 3, notice_by_email: false }, cal());
    expect(c).toMatchObject({ notified_on: "2026-11-13", starts_on: "2026-11-17", due_on: "2026-11-19", weekend_days: 2 });
    expect(c.skipped).toEqual([{ day: "2026-11-16", reason: "holiday", name: "Independencia de Cartagena" }]);
    expect(c.notes).toContain("business_days");
  });

  it("deems an email notice made two business days after it was sent (art. 8 Ley 2213 de 2022)", () => {
    const c = computeDueDate({ trigger_date: "2026-11-18", unit: "business_days", amount: 5, notice_by_email: true }, cal());
    expect(c.notified_on).toBe("2026-11-20");
    expect(c.starts_on).toBe("2026-11-23");
    expect(c.due_on).toBe("2026-11-27");
    expect(c.notes).toContain("notice_by_email");
  });

  it("does not count court vacancy and moves past a holiday right after it", () => {
    // Friday 18 Dec 2026; vacancy 20 Dec–10 Jan; Monday 11 Jan 2027 is Reyes Magos.
    const c = computeDueDate({ trigger_date: "2026-12-18", unit: "business_days", amount: 3, notice_by_email: false }, cal([VACANCY]));
    expect(c.starts_on).toBe("2027-01-12");
    expect(c.due_on).toBe("2027-01-14");
    // 22 vacancy days: Christmas and New Year show as holidays, the other 20 as the closure.
    expect(c.skipped.filter((s) => s.reason === "closure")).toHaveLength(20);
    expect(c.skipped.filter((s) => s.reason === "holiday").map((s) => s.day)).toEqual(["2026-12-25", "2027-01-01", "2027-01-11"]);
  });

  it("moves calendar-day terms that end on a non-working day", () => {
    const sunday = computeDueDate({ trigger_date: "2026-11-05", unit: "calendar_days", amount: 10, notice_by_email: false }, cal());
    expect(sunday.nominal_due).toBe("2026-11-15");
    expect(sunday.due_on).toBe("2026-11-17"); // Sunday 15 -> Monday 16 is a holiday -> Tuesday 17
    expect(sunday.notes).toContain("moved_to_next_working_day");
    const plain = computeDueDate({ trigger_date: "2026-11-20", unit: "calendar_days", amount: 10, notice_by_email: false }, cal());
    expect(plain.due_on).toBe("2026-11-30");
  });

  it("ends a term of months on the day number it started running, or the end of a shorter month", () => {
    const c = computeDueDate({ trigger_date: "2026-01-15", unit: "months", amount: 1, notice_by_email: false }, cal());
    expect(c).toMatchObject({ starts_on: "2026-01-16", due_on: "2026-02-16" });
    const short = computeDueDate({ trigger_date: "2026-01-30", unit: "months", amount: 1, notice_by_email: false }, cal());
    expect(short.nominal_due).toBe("2026-02-28"); // 31 Feb does not exist; Saturday 28 -> Monday 2 March
    expect(short.due_on).toBe("2026-03-02");
    expect(short.notes).toEqual(expect.arrayContaining(["month_end", "moved_to_next_working_day"]));
    const year = computeDueDate({ trigger_date: "2026-03-20", unit: "years", amount: 1, notice_by_email: false }, cal());
    expect(year.due_on).toBe("2027-03-23"); // 21 March 2027 is Sunday, Monday 22 is San José
  });

  it("keeps a fixed date as written and says when it is not a working day", () => {
    const c = computeDueDate({ trigger_date: "2026-11-22", unit: "fixed", amount: null, notice_by_email: false }, cal());
    expect(c.due_on).toBe("2026-11-22");
    expect(c.notes).toEqual(["fixed_on_non_working_day", "fixed_date"]);
  });

  it("flags dates outside the loaded holidays and rejects bad input", () => {
    const c = computeDueDate({ trigger_date: "2040-01-02", unit: "business_days", amount: 1, notice_by_email: false }, cal());
    expect(c.notes).toContain("holidays_not_loaded");
    expect(() => computeDueDate({ trigger_date: "2026-02-30", unit: "business_days", amount: 1, notice_by_email: false }, cal())).toThrow();
    expect(() => computeDueDate({ trigger_date: "2026-02-03", unit: "business_days", amount: 0, notice_by_email: false }, cal())).toThrow();
  });
});

describe("helpers", () => {
  it("adds months clamping to the last day", () => {
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-08-31", 6)).toBe("2027-02-28");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
  });

  it("gives one reminder per day in non-overlapping windows", () => {
    const c = cal();
    const due = "2026-11-19"; // Thursday; two working days before = Tuesday 17 (Monday 16 is a holiday)
    expect(reminderFor(c, due, "2026-11-11")).toBeNull();
    expect(reminderFor(c, due, "2026-11-12")).toBe("week");
    expect(reminderFor(c, due, "2026-11-16")).toBe("week");
    expect(reminderFor(c, due, "2026-11-17")).toBe("two_days");
    expect(reminderFor(c, due, "2026-11-18")).toBe("two_days");
    expect(reminderFor(c, due, "2026-11-19")).toBe("due");
    expect(reminderFor(c, due, "2026-11-26")).toBe("overdue");
    expect(reminderFor(c, due, "2026-11-27")).toBeNull();
  });

  it("suggests Colombian court closures without adding them", () => {
    const holidays = new Map(HOLIDAYS.map(([d, n]) => [d, [n]]));
    expect(suggestedClosures("co", 2026, holidays)).toEqual([
      { starts_on: "2026-03-30", ends_on: "2026-04-01", label: "Semana Santa 2026" },
      { starts_on: "2026-12-20", ends_on: "2027-01-10", label: "Vacancia judicial 2026-2027" },
    ]);
    expect(suggestedClosures("mx", 2026, holidays)).toEqual([]);
  });

  it("knows today in Bogotá", () => {
    expect(todayIn("co", new Date("2026-11-20T03:00:00Z"))).toBe("2026-11-19");
  });

  it("writes a valid all-day calendar with escaping and folding", () => {
    const ics = toIcs(
      [{ id: "d1", title: "Contestar la demanda, Parra; Rosas", due_on: "2026-11-19", description: "Expediente D-16.857\nArt. 96 CGP — ".repeat(3) }],
      "Términos",
      new Date("2026-11-19T12:00:00Z"),
    );
    expect(ics).toContain("DTSTART;VALUE=DATE:20261119\r\n");
    expect(ics).toContain("DTEND;VALUE=DATE:20261120\r\n");
    expect(ics).toContain("SUMMARY:Vence: Contestar la demanda\\, Parra\\; Rosas");
    expect(ics.split("\r\n").every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
});
