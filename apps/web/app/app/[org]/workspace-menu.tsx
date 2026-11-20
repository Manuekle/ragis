"use client";

import type { Workspace } from "@/lib/api";
import { IconCheck, IconLock } from "@/components/icons";
import { useT } from "@/lib/use-t";

/**
 * Items of a workspace switcher. The spaces the person belongs to come first. Owners and admins also see the others,
 * to manage who has access, under their own label: their documents and questions stay closed until the admin joins.
 */
export function WorkspaceMenuItems({
  workspaces,
  workspaceId,
  onPick,
  showTeamTags = false,
}: {
  workspaces: Workspace[];
  workspaceId: string;
  onPick: (id: string) => void;
  showTeamTags?: boolean;
}) {
  const tr = useT();
  const mine = workspaces.filter((w) => w.my_role);
  const others = workspaces.filter((w) => !w.my_role);
  const item = (w: Workspace) => (
    <button key={w.id} type="button" role="menuitemradio" aria-checked={w.id === workspaceId} className="menu-item" onClick={() => onPick(w.id)}>
      {showTeamTags && w.team_color && <span className="team-dot" data-team-color={w.team_color} aria-hidden="true" />}
      {w.name}
      {!w.my_role && (
        <>
          <IconLock size={13} className="faint" />
          <span className="sr-only">{tr("(not a member)")}</span>
        </>
      )}
      {w.id === workspaceId && <IconCheck className="check" size={15} />}
    </button>
  );
  return (
    <>
      <div className="menu-label">{tr("Workspaces")}</div>
      {mine.map(item)}
      {others.length > 0 && (
        <>
          <div className="menu-label">{tr("Not a member (admin only)")}</div>
          {others.map(item)}
        </>
      )}
    </>
  );
}
