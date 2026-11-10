"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "@/lib/api";
import { useOrg } from "../layout";
import { AppErrorState, requestErrorKind } from "@/components/AppState";
import { IconAlert, IconCopy, IconCopyCheck, IconFolder, IconMail, IconX } from "@/components/icons";
import { Checkbox, Seg, SoftText, Swap, Toast } from "@/components/motion";
import { Skel, SkeletonStatus, SkeletonTable } from "@/components/skeletons";
import { Select, TextField, useConfirm, useFormErrors, Avatar } from "@/components/ui";
import { cap, humanize } from "@/lib/plain";

const ROLES = [
  { value: "member", label: "Member", hint: "Asks questions and uploads documents" },
  { value: "viewer", label: "Viewer", hint: "Can only read" },
  { value: "admin", label: "Admin", hint: "Manages people, settings and integrations" },
];

interface Member { id: string; email: string; display_name: string | null; role: string; status: string }
interface Group { id: string; name: string; members: number }
interface ApiKey { id: string; name: string; prefix: string; scopes: string[]; workspace_ids: string[]; created_at: string; expires_at: string | null; last_used_at: string | null; revoked_at: string | null }
const SCOPES = ["query", "documents:read", "documents:write"] as const;
const SCOPE_COPY: Record<string, string> = { query: "Ask questions", "documents:read": "Read documents", "documents:write": "Upload documents" };
interface RoleMember { id: string; email: string; display_name: string | null; org_role: string; roles: string[] }
const FUNCTIONAL_ROLES: { id: string; label: string; hint: string }[] = [
  { id: "reviewer", label: "Reviewer", hint: "Reviews agent outputs in workflows" },
  { id: "approver", label: "Approver", hint: "Gives the final OK on a specific document version" },
  { id: "signatory", label: "Signatory", hint: "Can sign documents and approve sending them for signature" },
  { id: "auditor", label: "Auditor", hint: "Can see every workflow and its full history" },
];
interface AuditEvent { id: number; action: string; resource: string; decision: string; created_at: string; hash: string; actor_id: string | null }

function CopyButton({ text, label = "Copy key" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="quiet icon small"
      aria-label={done ? "Copied" : label}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1600);
      }}
    >
      <Swap on={done} a={<IconCopy size={16} />} b={<IconCopyCheck size={16} variant="duotone" />} />
    </button>
  );
}

const date = (s: string) => new Date(s).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const day = (s: string) => new Date(s).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });
const time = (s: string) => new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

type Tab = "members" | "roles" | "sharing" | "groups" | "keys" | "audit";
const TABS: { id: Tab; label: string }[] = [
  { id: "members", label: "Members" },
  { id: "roles", label: "Roles" },
  { id: "sharing", label: "Sharing" },
  { id: "groups", label: "Groups" },
  { id: "keys", label: "Integrations" },
  { id: "audit", label: "Activity log" },
];

type LoadStatus = "loading" | "ready" | "failed";

function GovernanceTable({
  status,
  label,
  columns,
  leading,
  children,
}: {
  status: LoadStatus;
  label: string;
  columns: readonly string[];
  leading?: "avatar";
  children: ReactNode;
}) {
  if (status === "failed") return null;
  if (status === "loading") {
    return (
      <SkeletonStatus label={label}>
        <SkeletonTable rows={5} columns={columns} leading={leading} />
      </SkeletonStatus>
    );
  }
  return <div className="table-card">{children}</div>;
}

function Resource({ value }: { value: string }) {
  const i = value.indexOf(":");
  if (i < 0) return <span className="muted">{humanize(value)}</span>;
  // The id stays in the tooltip for auditors; the row reads as plain words.
  return (
    <span className="res" data-tip={value}>
      <span>{humanize(value.slice(0, i))}</span>
    </span>
  );
}

export default function AdminPage() {
  const { org } = useParams<{ org: string }>();
  const { workspaceId, workspaces } = useOrg();
  const [members, setMembers] = useState<Member[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [groupName, setGroupName] = useState("");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [roleMembers, setRoleMembers] = useState<RoleMember[]>([]);
  const [ext, setExt] = useState<{ allowed_domains: string[]; share_max_days: number; approval_max_age_hours: number; require_mfa_for_signature: boolean; esign_provider?: string } | null>(null);
  const [loadingSharing, setLoadingSharing] = useState(true);
  const [dataStatus, setDataStatus] = useState<LoadStatus>("loading");
  const [revision, setRevision] = useState(0);
  const [newDomain, setNewDomain] = useState("");
  useEffect(() => {
    let active = true;
    api<NonNullable<typeof ext>>(`organizations/${org}/external-policy`)
      .then((policy) => { if (active) setExt(policy); })
      .catch(() => undefined)
      .finally(() => { if (active) setLoadingSharing(false); });
    return () => { active = false; };
  }, [org, revision]);
  const saveExt = (next: NonNullable<typeof ext>) =>
    run(async () => {
      const { esign_provider: _p, ...body } = next as typeof next & { can_edit?: boolean };
      delete (body as { can_edit?: boolean }).can_edit;
      setExt(await api<NonNullable<typeof ext>>(`organizations/${org}/external-policy`, { method: "PUT", body }));
    }, "External sharing policy saved");
  const [keyName, setKeyName] = useState("");
  const [keyScopes, setKeyScopes] = useState<string[]>(["query"]);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);
  const confirm = useConfirm();
  const memberForm = useFormErrors();
  const groupForm = useFormErrors();
  const keyForm = useFormErrors();
  const [tab, setTabState] = useState<Tab>("members");
  const [decision, setDecision] = useState<"all" | "allow" | "deny">("all");

  useEffect(() => {
    const sync = () => {
      const h = window.location.hash.slice(1) as Tab;
      if (TABS.some((t) => t.id === h)) setTabState(h);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  const setTab = (t: Tab) => {
    setTabState(t);
    history.replaceState(null, "", `#${t}`);
  };

  const load = useCallback(async () => {
    try {
      const [m, g, a, k, fr] = await Promise.all([
        api<{ members: Member[] }>(`organizations/${org}/members`),
        api<{ groups: Group[] }>(`organizations/${org}/groups`),
        api<{ events: AuditEvent[] }>(`organizations/${org}/audit`),
        api<{ api_keys: ApiKey[] }>(`organizations/${org}/api-keys`),
        api<{ members: RoleMember[] }>(`organizations/${org}/functional-roles`),
      ]);
      setRoleMembers(fr.members);
      setKeys(k.api_keys);
      setMembers(m.members);
      setGroups(g.groups);
      setEvents(a.events);
      setDataStatus("ready");
    } catch (e) {
      setDataStatus((current) => current === "ready" ? current : "failed");
      setError(e as Error);
    }
  }, [org]);

  useEffect(() => {
    load();
  }, [load, revision]);

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    try {
      await fn();
      setNotice(ok);
      load();
    } catch (e) {
      setError(e as Error);
    }
  };

  const wsName = workspaces.find((w) => w.id === workspaceId)?.name ?? "workspace";
  const counts: Record<Tab, number> = { sharing: ext?.allowed_domains.length ?? 0, roles: roleMembers.filter((m) => m.roles.length).length, members: members.length, groups: groups.length, keys: keys.filter((k) => !k.revoked_at).length, audit: events.length };
  const denied = events.filter((e) => e.decision !== "allow").length;
  const shownEvents = events.filter((e) => (decision === "all" ? true : decision === "allow" ? e.decision === "allow" : e.decision !== "allow"));
  const errorKind = dataStatus === "failed" ? requestErrorKind(error) : null;

  function retryLoad() {
    setError(null);
    setDataStatus("loading");
    setLoadingSharing(true);
    setRevision((value) => value + 1);
  }

  function onTabKey(e: React.KeyboardEvent) {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    const t = TABS[(next + TABS.length) % TABS.length];
    setTab(t.id);
    document.getElementById(`tab-${t.id}`)?.focus();
  }

  if (errorKind) {
    return (
      <div className="main">
        <AppErrorState kind={errorKind} backHref={`/app/${org}/ask`} backLabel="Back to Ask" onRetry={retryLoad} />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-bar">
        <div className="crumbs">
          <strong>Governance</strong>
          <span className="crumb-sep" aria-hidden="true">/</span>
          <span className="crumb-ws">
            <IconFolder size={15} />
            {wsName}
          </span>
        </div>
      </header>

      <div className="main">
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>Governance</h1>
            <p className="sub">People, roles, groups, sharing rules, integrations and the activity log.</p>
          </div>
        </header>

        <div className="tabs" role="tablist" aria-label="Governance sections" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              id={`tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {(t.id === "sharing" ? loadingSharing : dataStatus === "loading") ? (
                <Skel w={16} h={13} r={999} />
              ) : (t.id === "sharing" ? !!ext : dataStatus === "ready") && <span className="count"><SoftText text={String(counts[t.id])} /></span>}
            </button>
          ))}
        </div>

        {error && (
          <div className="alert" style={{ marginTop: 20 }}>
            <IconAlert size={16} />
            <span style={{ flex: 1 }}>{error.message}</span>
            <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label="Dismiss">
              <IconX size={14} />
            </button>
          </div>
        )}

        {tab === "members" && (
          <section className="tab-panel" id="panel-members" role="tabpanel" aria-labelledby="tab-members" key="members">
            <div className="section-head">
              <div>
                <p>The person must have signed in at least once.</p>
              </div>
            </div>
            <form
              className="form-card inline-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (!memberForm.validate(e.currentTarget)) return;
                run(() => api(`organizations/${org}/members`, { method: "POST", body: { email, role } }), "Member added").then(() => setEmail(""));
              }}
            >
              <TextField type="email" required icon={IconMail} placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Member email" {...memberForm.field("email")} />
              <Select value={role} onChange={setRole} options={ROLES} ariaLabel="Role" />
              <button type="submit" className="primary">Add member</button>
            </form>
            <GovernanceTable status={dataStatus} label="Loading members…" columns={["", "hide-sm", "", "hide-sm"]} leading="avatar">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th className="hide-sm">Role</th>
                      <th>Access to {wsName}</th>
                      <th className="hide-sm">Groups</th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <div className="cell-title">
                            <Avatar name={m.email} size="sm" />
                            <div style={{ minWidth: 0 }}>
                              <strong>{m.display_name ?? m.email.split("@")[0]}</strong>
                              <div className="muted ellipsis" style={{ fontSize: 13 }}>
                                {m.email}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="hide-sm">
                          <span className={`badge${m.role === "owner" || m.role === "admin" ? " accent" : ""}`}>{cap(m.role)}</span>
                        </td>
                        <td>
                          <div className="btn-group" role="group" aria-label={`Grant access to ${m.email}`}>
                            <button type="button" onClick={() => run(() => api(`organizations/${org}/workspaces/${workspaceId}/members`, { method: "POST", body: { user_id: m.id, role: "reader" } }), "Read access granted")}>
                              Can read
                            </button>
                            <button type="button" onClick={() => run(() => api(`organizations/${org}/workspaces/${workspaceId}/members`, { method: "POST", body: { user_id: m.id, role: "editor" } }), "Edit access granted")}>
                              Can edit
                            </button>
                          </div>
                        </td>
                        <td className="hide-sm">
                          <Select
                            size="sm"
                            value=""
                            placeholder={groups.length ? "Add to group…" : "No groups"}
                            ariaLabel={`Add ${m.email} to a group`}
                            options={groups.map((g) => ({ value: g.id, label: g.name, hint: `${g.members} ${g.members === 1 ? "member" : "members"}` }))}
                            onChange={(g) => run(() => api(`organizations/${org}/groups/${g}/members`, { method: "POST", body: { user_id: m.id } }), "Added to group")}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GovernanceTable>
          </section>
        )}

        {tab === "groups" && (
          <section className="tab-panel" id="panel-groups" role="tabpanel" aria-labelledby="tab-groups" key="groups">
            <div className="section-head">
              <div>
                <p>Put people in groups to give them access to documents together.</p>
              </div>
            </div>
            <form
              className="form-card inline-form"
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                if (!groupForm.validate(e.currentTarget)) return;
                run(() => api(`organizations/${org}/groups`, { method: "POST", body: { name: groupName } }), "Group created");
                setGroupName("");
              }}
            >
              <TextField required placeholder="Group name, e.g. Finance" value={groupName} onChange={(e) => setGroupName(e.target.value)} aria-label="Group name" {...groupForm.field("group")} />
              <button type="submit" className="primary">Create group</button>
            </form>
            <GovernanceTable status={dataStatus} label="Loading groups…" columns={["", "num", "hide-sm"]}>
              {groups.length === 0 ? (
                <div className="empty">
                  <strong>No groups yet</strong>
                  <span>Create one to share documents with several people at once.</span>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Group</th>
                        <th className="num">Members</th>
                        <th className="hide-sm">ID for integrations</th>
                      </tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <tr key={g.id}>
                          <td>
                            <div className="cell-title">
                              <Avatar name={g.name} size="sm" />
                              <strong>{g.name}</strong>
                            </div>
                          </td>
                          <td className="num">{g.members}</td>
                          <td className="hide-sm">
                            <span className="principal">
                              <code>group:{g.id}</code>
                              <CopyButton text={`group:${g.id}`} label="Copy group ID" />
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </GovernanceTable>
          </section>
        )}

        {tab === "keys" && (
          <section className="tab-panel" id="panel-keys" role="tabpanel" aria-labelledby="tab-keys" key="keys">
            <div className="section-head">
              <div>
                <p>Keys let other software connect to {wsName}. Usually set up by your IT team. Keys expire after 90 days and are shown only once.</p>
              </div>
            </div>
            <form
              className="form-card stack"
              style={{ gap: 14 }}
              noValidate
              onSubmit={async (e) => {
                e.preventDefault();
                if (!keyForm.validate(e.currentTarget)) return;
                setNewToken(null);
                await run(async () => {
                  const r = await api<{ token: string }>(`organizations/${org}/api-keys`, {
                    method: "POST",
                    body: { name: keyName, scopes: keyScopes, workspace_ids: [workspaceId], expires_in_days: 90 },
                  });
                  setNewToken(r.token);
                  setKeyName("");
                }, "Key created");
              }}
            >
              <div className="inline-form">
                <TextField required placeholder="Integration name" value={keyName} onChange={(e) => setKeyName(e.target.value)} aria-label="Integration name" {...keyForm.field("keyName")} />
                <button type="submit" className="primary" disabled={!keyScopes.length || !workspaceId}>
                  Create key
                </button>
              </div>
              <div className="scopes">
                <span className="scopes-label">What it can do</span>
                {SCOPES.map((sc) => (
                  <Checkbox
                    key={sc}
                    checked={keyScopes.includes(sc)}
                    onChange={(on) => setKeyScopes((cur) => (on ? [...cur, sc] : cur.filter((x) => x !== sc)))}
                    label={SCOPE_COPY[sc] ?? sc}
                  />
                ))}
              </div>
            </form>
            {newToken && (
              <div className="secret">
                <strong>Copy the key now. You won't be able to see it again.</strong>
                <div className="token">
                  <code>{newToken}</code>
                  <CopyButton text={newToken} />
                </div>
              </div>
            )}
            <GovernanceTable status={dataStatus} label="Loading API keys…" columns={["", "hide-sm", "hide-sm", "hide-md", "", ""]}>
              {keys.length === 0 ? (
                <div className="empty">
                  <strong>No keys yet</strong>
                  <span>Create one when you connect an integration.</span>
                </div>
              ) : (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Name</th>
                        <th className="hide-sm">Key</th>
                        <th className="hide-sm">Can</th>
                        <th className="hide-md">Last used</th>
                        <th>Status</th>
                        <th>
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((k) => (
                        <tr key={k.id}>
                          <td>
                            <strong style={{ fontWeight: 500 }}>{k.name}</strong>
                          </td>
                          <td className="mono muted hide-sm">rsk_{k.prefix}_…</td>
                          <td className="hide-sm">
                            <div className="row" style={{ gap: 4 }}>
                              {k.scopes.map((s) => (
                                <span key={s} className="badge" style={{ fontSize: 11.5 }}>
                                  {SCOPE_COPY[s] ?? s}
                                </span>
                              ))}
                            </div>
                          </td>
                          <td className="muted hide-md nowrap">{k.last_used_at ? date(k.last_used_at) : "Never"}</td>
                          <td>
                            {k.revoked_at ? (
                              <span className="badge err">
                                <span className="dot" />
                                Revoked
                              </span>
                            ) : k.expires_at && new Date(k.expires_at) < new Date() ? (
                              <span className="badge">
                                <span className="dot" />
                                Expired
                              </span>
                            ) : (
                              <span className="badge ok">
                                <span className="dot" />
                                Active
                              </span>
                            )}
                          </td>
                          <td className="actions">
                            {!k.revoked_at && (
                              <button
                                type="button"
                                className="danger small"
                                onClick={async () => {
                                  const ok = await confirm({ title: `Revoke "${k.name}"?`, body: "Integrations using it will stop working immediately.", confirmLabel: "Revoke", tone: "danger" });
                                  if (ok) run(() => api(`organizations/${org}/api-keys/${k.id}`, { method: "DELETE" }), "Key revoked");
                                }}
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </GovernanceTable>
          </section>
        )}

        {tab === "sharing" && loadingSharing && (
          <section className="tab-panel" id="panel-sharing" role="tabpanel" aria-labelledby="tab-sharing">
            <SkeletonStatus label="Loading external sharing policy…" className="form-card stack">
              <Skel w={160} h={14} />
              <Skel w="70%" h={38} r={10} />
              <div className="ob-fields">
                <Skel h={38} r={10} />
                <Skel h={38} r={10} />
              </div>
              <Skel w="64%" h={18} />
            </SkeletonStatus>
          </section>
        )}
        {tab === "sharing" && !loadingSharing && ext && (
          <section className="tab-panel" id="panel-sharing" role="tabpanel" aria-labelledby="tab-sharing" key="sharing">
            <div className="section-head">
              <div>
                <p>Choose who outside your organization can receive documents and for how long. With no domains listed, nothing can be shared outside.</p>
                <p>Electronic signatures · {ext.esign_provider === "native" ? "Ragsis Sign" : ext.esign_provider === "local" ? "Development simulator" : "Disabled"}</p>
              </div>
            </div>
            <div className="form-card stack" style={{ gap: 16 }}>
              <div className="ob-group">
                <span className="label">Companies you can share with (email domains)</span>
                <div className="domain-chips">
                  {ext.allowed_domains.length === 0 && <span className="muted" style={{ fontSize: 13 }}>None — nothing can be shared externally.</span>}
                  {ext.allowed_domains.map((d) => (
                    <span key={d} className="badge">
                      {d}
                      <button type="button" className="quiet icon small" aria-label={`Remove ${d}`} style={{ width: 18, height: 18 }} onClick={() => saveExt({ ...ext, allowed_domains: ext.allowed_domains.filter((x) => x !== d) })}>
                        <IconX size={12} />
                      </button>
                    </span>
                  ))}
                </div>
                <form
                  className="inline-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const d = newDomain.trim().toLowerCase().replace(/^@/, "");
                    if (!d) return;
                    saveExt({ ...ext, allowed_domains: [...new Set([...ext.allowed_domains, d])] }).then(() => setNewDomain(""));
                  }}
                >
                  <TextField placeholder="partner.com" value={newDomain} onChange={(e) => setNewDomain(e.target.value)} aria-label="Domain to allow" />
                  <button type="submit" className="primary" disabled={!newDomain.trim()}>
                    Allow domain
                  </button>
                </form>
              </div>
              <div className="ob-fields">
                <TextField label="Shared links expire after (days)" type="number" min={1} max={30} value={ext.share_max_days} onChange={(e) => setExt({ ...ext, share_max_days: Number(e.target.value) })} onBlur={() => saveExt(ext)} />
                <TextField label="An approval is valid for (hours)" type="number" min={1} max={168} value={ext.approval_max_age_hours} onChange={(e) => setExt({ ...ext, approval_max_age_hours: Number(e.target.value) })} onBlur={() => saveExt(ext)} />
              </div>
              <Checkbox checked={ext.require_mfa_for_signature} onChange={(on) => saveExt({ ...ext, require_mfa_for_signature: on })} label="Require two-step sign-in to approve sending documents for signature" />
            </div>
          </section>
        )}

        {tab === "roles" && (
          <section className="tab-panel" id="panel-roles" role="tabpanel" aria-labelledby="tab-roles" key="roles">
            <div className="section-head">
              <div>
                <p>Roles decide who reviews and approves steps in workflows. Whoever starts a workflow can't approve it themselves.</p>
                <p>{FUNCTIONAL_ROLES.map((r) => `${r.label}: ${r.hint.toLowerCase()}`).join(" · ")}.</p>
              </div>
            </div>
            <GovernanceTable status={dataStatus} label="Loading roles…" columns={["", ""]} leading="avatar">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Member</th>
                      <th>Roles</th>
                    </tr>
                  </thead>
                  <tbody>
                    {roleMembers.map((m) => (
                      <tr key={m.id}>
                        <td>
                          <div className="cell-title">
                            <Avatar name={m.email} size="sm" />
                            <div style={{ minWidth: 0 }}>
                              <strong>{m.display_name ?? m.email.split("@")[0]}</strong>
                              <div className="muted ellipsis" style={{ fontSize: 13 }}>
                                {m.email} · {cap(m.org_role)}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td>
                          <div className="chips" role="group" aria-label={`Roles for ${m.email}`}>
                            {FUNCTIONAL_ROLES.map((r) => {
                              const on = m.roles.includes(r.id);
                              return (
                                <button
                                  key={r.id}
                                  type="button"
                                  className="chip"
                                  aria-pressed={on}
                                  onClick={() =>
                                    run(
                                      () => api(`organizations/${org}/members/${m.id}/functional-roles`, { method: "PUT", body: { roles: on ? m.roles.filter((x) => x !== r.id) : [...m.roles, r.id] } }),
                                      on ? `${r.label} removed` : `${r.label} granted`,
                                    )
                                  }
                                >
                                  {r.label}
                                </button>
                              );
                            })}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </GovernanceTable>
          </section>
        )}

        {tab === "audit" && (
          <section className="tab-panel" id="panel-audit" role="tabpanel" aria-labelledby="tab-audit" key="audit">
            <div className="toolbar">
              <div className="section-head">
                <div>
                  <p>The last 200 actions in your organization. The log is tamper-proof.</p>
                </div>
              </div>
              <Seg role="group" aria-label="Filter by decision">
                {(
                  [
                    ["all", "All", events.length],
                    ["allow", "Allowed", events.length - denied],
                    ["deny", "Blocked", denied],
                  ] as const
                ).map(([k, label, n]) => (
                  <button key={k} type="button" aria-pressed={decision === k} onClick={() => setDecision(k)}>
                    {label}
                    {dataStatus === "loading" ? <Skel w={16} h={13} r={999} /> : dataStatus === "ready" && <span className="count"><SoftText text={String(n)} /></span>}
                  </button>
                ))}
              </Seg>
            </div>
            <GovernanceTable status={dataStatus} label="Loading audit log…" columns={["", "", "hide-sm", "", "hide-md"]}>
              {shownEvents.length === 0 ? (
                <div className="empty">
                  <strong>No events</strong>
                  <span>{decision === "deny" ? "Nothing has been blocked." : "No activity recorded yet."}</span>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="audit">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Action</th>
                        <th className="hide-sm">On</th>
                        <th>Result</th>
                        <th className="hide-md">Fingerprint</th>
                      </tr>
                    </thead>
                    <tbody>
                      {shownEvents.map((ev) => (
                        <tr key={ev.id}>
                          <td className="nowrap" title={date(ev.created_at)}>
                            <div className="tnum">{day(ev.created_at)}</div>
                            <div className="muted tnum" style={{ fontSize: 12.5 }}>
                              {time(ev.created_at)}
                            </div>
                          </td>
                          <td>
                            <span className="action" data-tip={ev.action}>{humanize(ev.action)}</span>
                          </td>
                          <td className="hide-sm">
                            <Resource value={ev.resource} />
                          </td>
                          <td>
                            <span className={`badge ${ev.decision === "allow" ? "ok" : "err"}`}>
                              <span className="dot" />
                              {ev.decision === "allow" ? "Allowed" : ev.decision === "deny" ? "Blocked" : cap(ev.decision)}
                            </span>
                          </td>
                          <td className="mono faint hide-md">{ev.hash.slice(0, 10)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </GovernanceTable>
          </section>
        )}

        <Toast message={notice} onDone={clearNotice} />
      </div>
    </div>
  );
}
