"use client";

import Link from "next/link";
import { useState } from "react";
import { StateIllustration } from "@/components/AppState";
import { IconAlert, IconArrowRight } from "@/components/icons";
import { api, type Workspace } from "@/lib/api";
import { useT } from "@/lib/use-t";
import { useOrg } from "./layout";

/**
 * A space the person is not a member of. Owners and admins see it in the switcher to manage who has access, but its
 * documents and questions are only for its members (the ACL never opens to admins on its own), so instead of failing
 * with «workspace not found» the page says so and offers to join it. Joining a team's space joins the team.
 */
export function WorkspaceNoAccess({ orgId, workspace }: { orgId: string; workspace: Workspace }) {
  const tr = useT();
  const { org, reloadWorkspaces } = useOrg();
  const isAdmin = org?.role === "owner" || org?.role === "admin";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const me = await api<{ user: { id: string } }>("me");
      await api(`organizations/${orgId}/workspaces/${workspace.id}/members`, { method: "POST", body: { user_id: me.user.id, role: "editor" } });
      await reloadWorkspaces();
    } catch {
      setError(tr("Couldn't add you to this space. Try again in a moment."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card empty" role="status">
      <StateIllustration kind="forbidden" />
      <strong>{tr("You're not a member of {name}", { name: workspace.name })}</strong>
      <span>
        {isAdmin
          ? tr("Its documents and questions are only for its members. As an admin you see it here to manage who has access.")
          : tr("Its documents and questions are only for its members. Ask an admin to add you.")}
        {isAdmin && workspace.team_id ? ` ${tr("It is a team's space: joining it adds you to the team.")}` : ""}
      </span>
      {isAdmin && (
        <div className="row">
          <button type="button" className="primary small" onClick={join} disabled={busy}>
            {busy ? tr("Joining…") : tr("Join this space")}
          </button>
          <Link href={`/app/${orgId}/admin`} className="btn-link">
            {tr("Manage access")}
            <IconArrowRight size={14} />
          </Link>
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          <IconAlert size={16} />
          {error}
        </div>
      )}
    </div>
  );
}
