import type { Deps } from "../app.js";
import { withContext } from "../db/pool.js";
import { addDays, hourIn, loadCalendarFor, reminderFor, todayIn, type Calendar } from "./deadlines.js";

/**
 * Reminder sweep for deadlines (ADR-038). Runs in the API next to the signature-invitation worker.
 *
 * The cross-tenant read is a SECURITY DEFINER function that only returns pending deadlines in a window around today;
 * each reminder is then claimed inside its tenant (deadline_reminders, unique per deadline, kind and due date) before
 * the email goes out, so replicas never double-send and a moved due date gets its reminders again. Emails go out from
 * 7:00 in the firm's country.
 */
interface WindowRow {
  organization_id: string;
  organization_name: string;
  holiday_country: string;
  deadline_id: string;
  title: string;
  due_on: string;
  legal_basis: string;
  document_title: string | null;
  page: number | null;
  responsible_email: string;
  responsible_name: string | null;
  sent: string[];
}

export async function sendDeadlineReminders(deps: Deps, now: Date = new Date()): Promise<number> {
  const send = deps.deadlineMailer;
  if (!send) return 0;
  const utc = now.toISOString().slice(0, 10);
  const rows = (
    await withContext(deps.pool, {}, (db) =>
      db.query(
        `SELECT organization_id, organization_name, holiday_country, deadline_id, title, due_on::text AS due_on, legal_basis,
                document_title, page, responsible_email, responsible_name, sent
           FROM app.deadline_reminder_window($1, $2)`,
        [addDays(utc, -9), addDays(utc, 9)],
      ),
    )
  ).rows as WindowRow[];
  const byOrg = new Map<string, WindowRow[]>();
  for (const r of rows) byOrg.set(r.organization_id, [...(byOrg.get(r.organization_id) ?? []), r]);
  let sent = 0;
  for (const [organizationId, list] of byOrg) {
    const country = list[0]?.holiday_country ?? "co";
    if (hourIn(country, now) < 7) continue;
    const today = todayIn(country, now);
    const ctx = { organizationId };
    const cal: Calendar = await withContext(deps.pool, ctx, (db) => loadCalendarFor(db, country));
    for (const r of list) {
      const kind = reminderFor(cal, r.due_on, today);
      if (!kind || r.sent.includes(kind)) continue;
      const claimed = await withContext(deps.pool, ctx, async (db) =>
        (
          await db.query(
            `INSERT INTO deadline_reminders (deadline_id, organization_id, kind, due_on, recipient) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (deadline_id, kind, due_on) DO UPDATE SET attempts = deadline_reminders.attempts + 1, last_attempt_at = now()
              WHERE deadline_reminders.sent_at IS NULL AND deadline_reminders.attempts < 5
                AND deadline_reminders.last_attempt_at < now() - interval '10 minutes'
             RETURNING attempts`,
            [r.deadline_id, organizationId, kind, r.due_on, r.responsible_email],
          )
        ).rows[0],
      );
      if (!claimed) continue;
      try {
        await send({
          to: r.responsible_email,
          name: r.responsible_name,
          kind,
          title: r.title,
          dueOn: r.due_on,
          organization: r.organization_name,
          legalBasis: r.legal_basis,
          documentTitle: r.document_title,
          page: r.page,
          url: `${deps.cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/app/${organizationId}/deadlines?d=${r.deadline_id}`,
        });
      } catch {
        continue; // retried on a later sweep (attempts / last_attempt_at)
      }
      await withContext(deps.pool, ctx, (db) =>
        db.query("UPDATE deadline_reminders SET sent_at = now() WHERE deadline_id = $1 AND kind = $2 AND due_on = $3", [r.deadline_id, kind, r.due_on]),
      );
      sent++;
    }
  }
  return sent;
}
