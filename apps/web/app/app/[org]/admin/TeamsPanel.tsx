"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { FormDialog } from "@/components/FormDialog";
import { Checkbox } from "@/components/motion";
import { Avatar, Select, TextField } from "@/components/ui";
import { IconEdit, IconPlus, IconTeam } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { useOrg, type TeamDir, type TeamSuggestion } from "../layout";

/**
 * Governance → Teams (ADR-035). The company's managers (admins) create the departments and put each person in theirs.
 * Each team gets its own private space, so its documents and answers stay inside it. Leads pick up what other teams
 * ask the team in the Inbox.
 */

export const TEAM_COLORS = ["blue", "green", "amber", "red", "violet", "teal", "pink", "slate"] as const;
type TeamColor = (typeof TEAM_COLORS)[number];

interface Person {
  id: string;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
}

const teamsChanged = () => window.dispatchEvent(new Event("ragsis:teams"));

export function TeamsPanel({
  org,
  members,
  loading,
  onNotice,
  onError,
}: {
  org: string;
  members: Person[];
  loading: boolean;
  onNotice: (message: string) => void;
  onError: (error: Error) => void;
}) {
  const { teams, teamSuggestions } = useOrg();
  const [dialog, setDialog] = useState<{ team?: TeamDir } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const active = (teams ?? []).filter((t) => !t.archived_at);
  const archived = (teams ?? []).filter((t) => t.archived_at);
  const people = members.filter((m) => m.status === "active");

  const act = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    try {
      await fn();
      teamsChanged();
      onNotice(ok);
    } catch (e) {
      onError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const createSuggested = (s: TeamSuggestion) =>
    act(`new:${s.name}`, () => api(`organizations/${org}/teams`, { method: "POST", body: { name: s.name, description: s.description, color: s.color } }), s.existing_workspace ? `${s.name} created from the existing space, with its people` : `${s.name} created`);

  const toggle = (t: TeamDir, p: Person, on: boolean) =>
    act(
      `${t.id}:${p.id}`,
      () => api(`organizations/${org}/teams/${t.id}/members/${p.id}`, on ? { method: "DELETE" } : { method: "PUT", body: {} }),
      on ? `${label(p)} left ${t.name}` : `${label(p)} joined ${t.name}`,
    );

  const setLead = (p: Person, mine: TeamDir[], teamId: string) =>
    act(
      `lead:${p.id}`,
      async () => {
        for (const t of mine) {
          const isLead = t.people.some((x) => x.id === p.id && x.lead);
          if (t.id === teamId && !isLead) await api(`organizations/${org}/teams/${t.id}/members/${p.id}`, { method: "PUT", body: { lead: true } });
          if (t.id !== teamId && isLead) await api(`organizations/${org}/teams/${t.id}/members/${p.id}`, { method: "PUT", body: { lead: false } });
        }
      },
      teamId ? `${label(p)} now leads ${mine.find((t) => t.id === teamId)?.name}` : `${label(p)} no longer leads a team`,
    );

  return (
    <>
      <div className="section-head">
        <div>
          <p>Each team gets its own private space: its documents and answers stay inside the team. Put each person in their team. Leads pick up what other teams ask in their Inbox.</p>
        </div>
        <button type="button" className="primary" onClick={() => setDialog({})}>
          <IconPlus size={16} />
          New team
        </button>
      </div>

      {(active.length > 0 || teamSuggestions.length > 0 || archived.length > 0) && (
        <div className="team-strip" aria-label="Teams">
          {active.map((t) => (
            <button key={t.id} type="button" className="team-pill" data-team-color={t.color} onClick={() => setDialog({ team: t })} aria-label={`Edit ${t.name}`}>
              <span className="team-dot" aria-hidden="true" />
              <span className="name">{t.name}</span>
              <span className="count">{t.member_count}</span>
              <IconEdit size={13} className="edit" />
            </button>
          ))}
          {teamSuggestions.map((s) => (
            <button
              key={s.name}
              type="button"
              className="team-pill suggest"
              data-team-color={s.color}
              disabled={busy === `new:${s.name}`}
              aria-busy={busy === `new:${s.name}`}
              title={s.existing_workspace ? `Uses the existing ${s.name} space and its ${s.existing_workspace.members} people` : s.description}
              onClick={() => void createSuggested(s)}
            >
              <IconPlus size={13} />
              {s.name}
            </button>
          ))}
          {archived.map((t) => (
            <button key={t.id} type="button" className="team-pill archived" data-team-color={t.color} onClick={() => setDialog({ team: t })} aria-label={`Edit ${t.name} (archived)`}>
              <span className="team-dot" aria-hidden="true" />
              <span className="name">{t.name}</span>
              <span className="muted">archived</span>
            </button>
          ))}
        </div>
      )}

      {teams !== null && active.length === 0 ? (
        <div className="card empty">
          <StateIllustration kind="teams" />
          <strong>No teams yet</strong>
          <span>Start with the departments your company has. One click on a suggestion above creates it; then put people in it here.</span>
        </div>
      ) : (
        <div className="table-wrap" aria-busy={loading || teams === null}>
          <table>
            <thead>
              <tr>
                <th>Member</th>
                <th>Team</th>
                <th className="hide-sm">Lead of</th>
              </tr>
            </thead>
            <tbody>
              {people.map((p) => {
                const mine = active.filter((t) => t.people.some((x) => x.id === p.id));
                const leads = mine.find((t) => t.people.some((x) => x.id === p.id && x.lead));
                return (
                  <tr key={p.id}>
                    <td>
                      <div className="cell-title">
                        <Avatar name={p.email} size="sm" />
                        <div style={{ minWidth: 0 }}>
                          <strong>{label(p)}</strong>
                          <div className="muted ellipsis" style={{ fontSize: 13 }}>
                            {p.email}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="chips" role="group" aria-label={`Teams for ${p.email}`}>
                        {active.map((t) => {
                          const on = mine.includes(t);
                          return (
                            <button
                              key={t.id}
                              type="button"
                              className="chip team-toggle"
                              data-team-color={t.color}
                              aria-pressed={on}
                              disabled={busy === `${t.id}:${p.id}`}
                              aria-busy={busy === `${t.id}:${p.id}`}
                              onClick={() => void toggle(t, p, on)}
                            >
                              <span className="team-dot" aria-hidden="true" />
                              {t.name}
                            </button>
                          );
                        })}
                      </div>
                    </td>
                    <td className="hide-sm">
                      {mine.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        <Select
                          size="sm"
                          ariaLabel={`Team ${p.email} leads`}
                          value={leads?.id ?? ""}
                          onChange={(v) => void setLead(p, mine, v)}
                          options={[{ value: "", label: "Not a lead" }, ...mine.map((t) => ({ value: t.id, label: t.name }))]}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {dialog && (
        <TeamDialog
          org={org}
          team={dialog.team}
          onClose={() => setDialog(null)}
          onSaved={(name, created) => {
            setDialog(null);
            teamsChanged();
            onNotice(created ? `${name} created` : `${name} saved`);
          }}
        />
      )}
    </>
  );
}

const label = (p: Person) => p.display_name ?? p.email.split("@")[0];

function ColorPicks({ value, onChange }: { value: TeamColor; onChange: (c: TeamColor) => void }) {
  return (
    <div className="color-picks" role="radiogroup" aria-label="Team color">
      {TEAM_COLORS.map((c) => (
        <button key={c} type="button" role="radio" aria-checked={value === c} aria-pressed={value === c} aria-label={c} data-team-color={c} onClick={() => onChange(c)} />
      ))}
    </div>
  );
}

/** Create or edit a team: name (its space is renamed with it), what it handles, color, archived. */
function TeamDialog({
  org,
  team,
  onClose,
  onSaved,
}: {
  org: string;
  team?: TeamDir;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const [name, setName] = useState(team?.name ?? "");
  const [description, setDescription] = useState(team?.description ?? "");
  const [color, setColor] = useState<TeamColor>((team?.color as TeamColor) ?? "blue");
  const [archived, setArchived] = useState(!!team?.archived_at);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | undefined>();

  const submit = async () => {
    if (!name.trim()) {
      setNameError("Give the team a name.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (team) {
        await api(`organizations/${org}/teams/${team.id}`, {
          method: "PATCH",
          body: { name: name.trim(), description: description.trim(), color, ...(archived !== !!team.archived_at ? { archived } : {}) },
        });
      } else {
        await api(`organizations/${org}/teams`, { method: "POST", body: { name: name.trim(), description: description.trim(), color } });
      }
      onSaved(name.trim(), !team);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <FormDialog
      title={team ? `Edit ${team.name}` : "New team"}
      description={team ? "Renaming the team also renames its space." : "The team gets its own private space for documents. Put people in it from the table."}
      icon={IconTeam}
      submitLabel={team ? "Save" : "Create team"}
      busy={busy}
      wide
      onClose={onClose}
      onSubmit={submit}
    >
      {error && (
        <div className="alert" role="alert" style={{ marginTop: 12 }}>
          {error}
        </div>
      )}
      <TextField
        label="Name"
        value={name}
        maxLength={80}
        placeholder="e.g. Legal, Treasury, People"
        onChange={(e) => {
          setName(e.target.value);
          setNameError(undefined);
        }}
        error={nameError}
        data-autofocus
      />
      <div className="field">
        <label htmlFor="team-desc">What does this team handle? (optional)</label>
        <textarea id="team-desc" rows={2} maxLength={280} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Helps others know when to ask this team." style={{ minHeight: 64 }} />
      </div>
      <div className="field">
        <span className="field-label">Color</span>
        <ColorPicks value={color} onChange={setColor} />
      </div>
      {team && (
        <div className="field">
          <Checkbox checked={archived} onChange={setArchived} label="Archived: the team stops receiving new requests" />
        </div>
      )}
    </FormDialog>
  );
}
