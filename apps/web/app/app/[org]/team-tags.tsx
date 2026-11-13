"use client";

import { useOrg } from "./layout";

/** A team as screens show it: name and color (ADR-035). */
export interface TeamRef {
  id: string;
  name: string;
  color: string;
}

export function TeamChip({ team, size, title }: { team: TeamRef; size?: "sm"; title?: string }) {
  return (
    <span className={`team-chip${size === "sm" ? " sm" : ""}`} data-team-color={team.color} title={title}>
      <span className="team-dot" aria-hidden="true" />
      <span>{team.name}</span>
    </span>
  );
}

/**
 * The team label next to a person's name. Renders nothing while the company has fewer than two teams: with one team
 * (or none) the label would say the same thing for everybody.
 */
export function PersonTeams({ userId, max = 2 }: { userId: string | null | undefined; max?: number }) {
  const { teamsOf } = useOrg();
  const list = teamsOf(userId);
  if (!list.length) return null;
  return (
    <span className="person-teams">
      {list.slice(0, max).map((t) => (
        <TeamChip key={t.id} team={t} size="sm" title={t.lead ? `Leads ${t.name}` : t.name} />
      ))}
      {list.length > max && (
        <span className="more" title={list.slice(max).map((t) => t.name).join(", ")}>
          +{list.length - max}
        </span>
      )}
    </span>
  );
}
