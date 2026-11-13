/**
 * Rules for requests between teams (ADR-035). Pure functions: the routes load who-is-who, these decide.
 *
 * Board columns: open (new) → in_progress → waiting (on the requester) → done. declined and cancelled also close a
 * request. The receiving team does the work; the requester can cancel or reopen.
 */

export const REQUEST_STATUSES = ["open", "in_progress", "waiting", "done", "declined", "cancelled"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];
export const PRIORITIES = ["low", "normal", "high", "urgent"] as const;
export type Priority = (typeof PRIORITIES)[number];
export const TEAM_COLORS = ["blue", "green", "amber", "red", "violet", "teal", "pink", "slate"] as const;

const CLOSED: ReadonlySet<RequestStatus> = new Set(["done", "declined", "cancelled"]);
export const isClosed = (s: RequestStatus) => CLOSED.has(s);

/** Statuses that need a short note so the other side knows why (what info is missing, why it was declined). */
export const NOTE_REQUIRED: ReadonlySet<RequestStatus> = new Set(["waiting", "declined"]);

/** How the current person relates to a request. */
export interface Involvement {
  /** Filed it. */
  requester: boolean;
  /** Member of the receiving team. */
  receiver: boolean;
  /** Assigned to it. */
  assignee: boolean;
}

/** Which statuses this person may move the request to from `status`. */
export function allowedTransitions(status: RequestStatus, who: Involvement): RequestStatus[] {
  const out = new Set<RequestStatus>();
  const worker = who.receiver || who.assignee;
  if (worker) {
    if (!isClosed(status)) for (const s of ["open", "in_progress", "waiting", "done", "declined"] as const) out.add(s);
    // The team can reopen what it closed, never what the requester withdrew.
    else if (status !== "cancelled") out.add("in_progress");
  }
  if (who.requester) {
    if (!isClosed(status)) out.add("cancelled");
    else out.add("open"); // "this isn't solved": back to the team's queue
  }
  out.delete(status);
  return REQUEST_STATUSES.filter((s) => out.has(s));
}

/** Assigning (or unassigning) is the receiving team's call. */
export const canAssign = (status: RequestStatus, who: Involvement) => who.receiver && !isClosed(status);

/** Priority and due date: the requester sets them, the receiving team can adjust them, while the request is open. */
export const canEditDetails = (status: RequestStatus, who: Involvement) => (who.requester || who.receiver) && !isClosed(status);

/**
 * A reply from the requester while the team waits on them puts the request back in the team's hands.
 * Returns the new status, or null if the comment changes nothing.
 */
export function statusAfterComment(status: RequestStatus, who: Involvement): RequestStatus | null {
  return status === "waiting" && who.requester && !who.receiver ? "in_progress" : null;
}

/**
 * Does this request need something from me right now? Drives the Inbox counter.
 * - waiting: the team needs info from the requester;
 * - open and assigned to me: I haven't started it;
 * - open and unassigned in a team I triage (I'm a lead, or the team has no lead): someone has to pick it up.
 */
export function needsAttention(
  r: { status: RequestStatus; requested_by: string; assignee_id: string | null; to_team_id: string },
  me: string,
  triageTeams: ReadonlySet<string>,
): boolean {
  if (r.status === "waiting") return r.requested_by === me;
  if (r.status !== "open") return false;
  if (r.assignee_id) return r.assignee_id === me;
  return triageTeams.has(r.to_team_id);
}

/** Departments most companies have; offered as one-click teams to admins. */
export const SUGGESTED_TEAMS: { name: string; description: string; color: (typeof TEAM_COLORS)[number] }[] = [
  { name: "Legal", description: "Contracts, compliance and legal reviews.", color: "violet" },
  { name: "Finance & Treasury", description: "Payments, invoices, budgets and bank matters.", color: "green" },
  { name: "People", description: "Hiring, payroll and employee matters.", color: "pink" },
  { name: "Operations", description: "Day-to-day processes, suppliers and logistics.", color: "amber" },
  { name: "Sales", description: "Clients, proposals and commercial terms.", color: "blue" },
  { name: "Management", description: "Leadership decisions and company-wide priorities.", color: "slate" },
];
