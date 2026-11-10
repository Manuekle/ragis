"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { api } from "@/lib/api";
import { useOrg } from "../layout";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { ClickUpLogo, GmailLogo, SlackLogo } from "@/components/brand-logos";
import { IconAlert, IconBuilding, IconLock, IconPause, IconPlay, IconRefresh, IconSpinner, IconTrash, IconUser, IconX } from "@/components/icons";
import { Checkbox, Seg, Toast } from "@/components/motion";
import { Disclosure, Select, useConfirm } from "@/components/ui";
import { Skel, SkeletonStatus } from "@/components/skeletons";
import "./connections.css";

type ProviderId = "gmail" | "slack" | "clickup";

interface Provider {
  id: ProviderId;
  name: string;
  scope: "personal" | "organization";
  available: boolean;
  allowed: boolean;
}

interface Connection {
  id: string;
  provider: ProviderId;
  scope: "personal" | "organization";
  workspace_id: string;
  workspace_name: string;
  account_label: string;
  status: "needs_setup" | "active" | "paused" | "error";
  settings: Record<string, unknown>;
  last_sync_at: string | null;
  last_success_at: string | null;
  next_sync_at: string | null;
  last_error_code: string | null;
  owner_name: string | null;
  is_mine: boolean;
  allowed: boolean;
  syncing: boolean;
  item_count: number;
  problems: { id: string; problem: string }[];
}

interface Catalog {
  can_manage_company: boolean;
  demo: boolean;
  providers: Provider[];
  connectors: Connection[];
}

interface OptionGroup {
  key: string;
  label: string;
  multiple: boolean;
  options: { id: string; label: string; detail?: string; private?: boolean }[];
}

const APPS: Record<ProviderId, { Logo: (p: { size?: number }) => React.ReactNode; blurb: string; items: [string, string] }> = {
  gmail: { Logo: GmailLogo, blurb: "Search your emails and their attachments. Only you can see them — administrators can't.", items: ["item", "items"] },
  slack: { Logo: SlackLogo, blurb: "Search conversations from the channels you choose. Everyone in the folder can see them.", items: ["day of conversation", "days of conversation"] },
  clickup: { Logo: ClickUpLogo, blurb: "Search tasks, comments and Docs. Everyone in the folder can see them.", items: ["task or Doc", "tasks and Docs"] },
};

function ago(iso: string | null): string {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short" });
}

function problemText(c: Connection, name: string): string | null {
  switch (c.last_error_code) {
    case "reconnect_needed":
      return `Access to ${name} has expired. Reconnect to keep it up to date.`;
    case "owner_removed":
      return "The person who connected this is no longer in your organization. Reconnect it with your account.";
    case "workspace_access_lost":
      return `${c.is_mine ? "You no longer have" : "The person who connected this no longer has"} access to ${c.workspace_name}.`;
    case "quota_exceeded":
      return "Your plan's limit is reached. New items will be added when there's room.";
    case "rate_limited":
      return `${name} asked us to slow down. We'll continue shortly.`;
    case "sync_failed":
      return "The last update didn't finish. We'll try again automatically.";
    case "not_configured":
      return `${name} isn't set up on the server anymore. Ask your technical team.`;
    default:
      return null;
  }
}

function StatusBadge({ c }: { c: Connection }) {
  if (!c.allowed) return <span className="badge">Turned off by your administrator</span>;
  if (c.status === "needs_setup") return <span className="badge warn"><span className="dot" />Choose what to include</span>;
  if (c.status === "paused") return <span className="badge">Paused</span>;
  if (c.status === "error") return <span className="badge err"><span className="dot" />Needs attention</span>;
  if (c.syncing || !c.last_success_at) return <span className="badge accent"><IconSpinner size={11} />Updating…</span>;
  return <span className="badge ok"><span className="dot" />Up to date</span>;
}

/* ───────────── Settings editor ───────────── */

const GMAIL_RANGES: [number, string][] = [[1, "1 month"], [3, "3 months"], [6, "6 months"], [12, "1 year"]];
const SLACK_RANGES: [number, string][] = [[30, "1 month"], [90, "3 months"], [365, "1 year"]];

function OptionList({ group, selected, onChange, folder }: { group: OptionGroup; selected: string[]; onChange: (ids: string[]) => void; folder: string }) {
  const [q, setQ] = useState("");
  const shown = group.options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  const toggle = (id: string, on: boolean) => onChange(on ? [...new Set([...selected, id])] : selected.filter((x) => x !== id));
  if (!group.options.length) return <p className="muted conn-hint">Nothing to choose from yet.</p>;
  return (
    <div className="conn-options">
      {group.options.length > 8 && (
        <input className="conn-filter" type="search" placeholder="Filter…" value={q} onChange={(e) => setQ(e.target.value)} aria-label={`Filter ${group.label.toLowerCase()}`} />
      )}
      <div className="conn-option-list" role="group" aria-label={group.label}>
        {shown.map((o) => (
          <div key={o.id} className="conn-option">
            <Checkbox
              checked={selected.includes(o.id)}
              onChange={(v) => toggle(o.id, v)}
              label={
                <span className="conn-option-label">
                  {o.label}
                  {o.private && (
                    <span className="conn-private" data-tip={`Private in the app — everyone in ${folder} will be able to search it`}>
                      <IconLock size={12} />
                      Private
                    </span>
                  )}
                  {o.detail && <small className="muted">{o.detail}</small>}
                </span>
              }
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function SettingsEditor({ org, c, name, onDone }: { org: string; c: Connection; name: string; onDone: (saved: boolean) => void }) {
  const [groups, setGroups] = useState<OptionGroup[] | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>(c.settings);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    api<{ groups: OptionGroup[] }>(`organizations/${org}/connectors/${c.id}/options`)
      .then((r) => active && setGroups(r.groups))
      .catch((e: Error) => {
        if (!active) return;
        setGroups([]);
        setError(e.message);
      });
    return () => { active = false; };
  }, [org, c.id]);

  const set = (k: string, v: unknown) => setDraft((d) => ({ ...d, [k]: v }));
  const group = (key: string) => groups?.find((g) => g.key === key);
  const list = (k: string) => (Array.isArray(draft[k]) ? (draft[k] as string[]) : []);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api(`organizations/${org}/connectors/${c.id}`, { method: "PUT", body: { settings: draft } });
      onDone(true);
    } catch (e) {
      setError((e as Error).message);
      setSaving(false);
    }
  }

  const slackEmpty = c.provider === "slack" && list("channel_ids").length === 0;
  const clickupAll = c.provider === "clickup" && draft.space_ids == null;

  return (
    <div className="conn-editor">
      {groups === null ? (
        <SkeletonStatus label="Loading choices…">
          <div className="stack" style={{ gap: 8 }}>
            <Skel w="60%" h={14} />
            <Skel w="40%" h={14} />
            <Skel w="50%" h={14} />
          </div>
        </SkeletonStatus>
      ) : (
        <>
          {c.provider === "gmail" && (
            <>
              <div className="conn-field">
                <strong>How far back</strong>
                <Seg role="group" aria-label="How far back">
                  {GMAIL_RANGES.map(([v, l]) => (
                    <button key={v} type="button" aria-pressed={draft.backfill_months === v} onClick={() => set("backfill_months", v)}>{l}</button>
                  ))}
                </Seg>
                <small className="muted">New emails keep arriving after this. Promotions, social updates and spam are always left out.</small>
              </div>
              <div className="conn-field">
                <Checkbox checked={draft.include_attachments !== false} onChange={(v) => set("include_attachments", v)} label="Include attachments (PDF, Word, Excel, PowerPoint, images)" />
              </div>
              {group("label_ids") && (
                <Disclosure title="Only some labels" hint={list("label_ids").length ? `${list("label_ids").length} selected` : "All emails"}>
                  <p className="muted conn-hint">Leave everything unticked to bring in all your emails.</p>
                  <OptionList group={group("label_ids")!} selected={list("label_ids")} onChange={(ids) => set("label_ids", ids)} folder={c.workspace_name} />
                </Disclosure>
              )}
            </>
          )}

          {c.provider === "slack" && (
            <>
              <div className="conn-field">
                <strong>Channels</strong>
                <small className="muted">The app can read public channels you pick. To include a private channel, first invite the app to it in Slack.</small>
                {group("channel_ids") && <OptionList group={group("channel_ids")!} selected={list("channel_ids")} onChange={(ids) => set("channel_ids", ids)} folder={c.workspace_name} />}
              </div>
              <div className="conn-field">
                <strong>How far back</strong>
                <Seg role="group" aria-label="How far back">
                  {SLACK_RANGES.map(([v, l]) => (
                    <button key={v} type="button" aria-pressed={draft.backfill_days === v} onClick={() => set("backfill_days", v)}>{l}</button>
                  ))}
                </Seg>
              </div>
            </>
          )}

          {c.provider === "clickup" && (
            <>
              <div className="conn-field">
                <strong>Spaces</strong>
                <Seg role="group" aria-label="Which spaces">
                  <button type="button" aria-pressed={clickupAll} onClick={() => set("space_ids", null)}>All shared spaces</button>
                  <button
                    type="button"
                    aria-pressed={!clickupAll}
                    onClick={() => set("space_ids", (group("space_ids")?.options ?? []).filter((o) => !o.private).map((o) => o.id))}
                  >
                    Choose spaces
                  </button>
                </Seg>
                {clickupAll ? (
                  <small className="muted">Every space that isn't private, including new ones.</small>
                ) : (
                  group("space_ids") && <OptionList group={group("space_ids")!} selected={list("space_ids")} onChange={(ids) => set("space_ids", ids)} folder={c.workspace_name} />
                )}
              </div>
              <div className="conn-field">
                <Checkbox checked={draft.include_docs !== false} onChange={(v) => set("include_docs", v)} label="Include ClickUp Docs" />
              </div>
            </>
          )}
        </>
      )}

      {error && (
        <div className="alert">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      <div className="conn-editor-actions">
        <button type="button" className="quiet small" onClick={() => onDone(false)} disabled={saving}>
          Cancel
        </button>
        <button type="button" className="primary small" onClick={save} disabled={saving || groups === null || slackEmpty}>
          {saving && <IconSpinner size={14} />}
          {c.status === "needs_setup" ? `Start bringing in from ${name}` : "Save"}
        </button>
      </div>
    </div>
  );
}

/* ───────────── App card ───────────── */

function AppCard({
  org,
  p,
  conns,
  canManage,
  editing,
  setEditing,
  reload,
  notify,
}: {
  org: string;
  p: Provider;
  conns: Connection[];
  canManage: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  reload: () => void;
  notify: (m: string) => void;
}) {
  const { workspaces, workspaceId } = useOrg();
  const confirm = useConfirm();
  const { Logo, blurb, items } = APPS[p.id];
  const personal = p.scope === "personal";
  const mine = personal ? conns.filter((c) => c.is_mine) : conns;
  const canConnect = p.available && p.allowed && (personal || canManage) && (!personal || mine.length === 0);
  const folders = workspaces.filter((w) => w.my_role);
  const [folder, setFolder] = useState(folders.find((w) => w.id === workspaceId)?.id ?? folders[0]?.id ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!folder && folders[0]) setFolder(folders.find((w) => w.id === workspaceId)?.id ?? folders[0].id);
  }, [folders, folder, workspaceId]);

  async function run(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const connect = () =>
    run("connect", async () => {
      const r = await api<{ authorize_url: string }>(`organizations/${org}/connectors/${p.id}/authorize`, { method: "POST", body: { workspace_id: folder } });
      window.location.assign(r.authorize_url);
      await new Promise(() => undefined); // mantener el estado ocupado mientras el navegador sale de la página
    });

  const reconnect = (c: Connection) =>
    run(`reconnect:${c.id}`, async () => {
      const r = await api<{ authorize_url: string }>(`organizations/${org}/connectors/${p.id}/authorize`, { method: "POST", body: { workspace_id: c.workspace_id } });
      window.location.assign(r.authorize_url);
      await new Promise(() => undefined);
    });

  const syncNow = (c: Connection) =>
    run(`sync:${c.id}`, async () => {
      await api(`organizations/${org}/connectors/${c.id}/sync`, { method: "POST" });
      notify(`Updating ${p.name}…`);
      reload();
    });

  const pause = (c: Connection, paused: boolean) =>
    run(`pause:${c.id}`, async () => {
      await api(`organizations/${org}/connectors/${c.id}`, { method: "PUT", body: { paused } });
      reload();
    });

  async function disconnect(c: Connection) {
    const ok = await confirm({
      title: `Disconnect ${p.name}?`,
      body: `Everything brought in from ${p.name} will be removed from search${personal ? "" : ` for everyone in ${c.workspace_name}`}. Nothing is deleted in ${p.name} itself.`,
      confirmLabel: "Disconnect",
      tone: "danger",
    });
    if (!ok) return;
    await run(`delete:${c.id}`, async () => {
      await api(`organizations/${org}/connectors/${c.id}`, { method: "DELETE" });
      notify(`${p.name} disconnected`);
      reload();
    });
  }

  return (
    <article className="card conn-card" data-provider={p.id}>
      <header className="conn-head">
        <span className="conn-logo" aria-hidden="true">
          <Logo size={26} />
        </span>
        <div className="conn-title">
          <h2>{p.name}</h2>
          <p className="muted">{blurb}</p>
        </div>
      </header>

      {mine.map((c) => {
        const problem = problemText(c, p.name);
        const needsReconnect = c.status === "error" && (c.last_error_code === "reconnect_needed" || c.last_error_code === "owner_removed");
        const manage = personal ? c.is_mine : canManage;
        return (
          <section key={c.id} className="conn-account" aria-label={`${p.name} connection ${c.account_label}`}>
            <div className="conn-account-row">
              <div className="conn-account-meta">
                <strong>{c.account_label}</strong>
                <small className="muted">
                  {personal ? "Only you" : `Everyone in ${c.workspace_name}`}
                  {!personal && c.owner_name && ` · connected by ${c.is_mine ? "you" : c.owner_name}`}
                  {c.item_count > 0 && ` · ${c.item_count.toLocaleString("en-US")} ${items[c.item_count === 1 ? 0 : 1]}`}
                  {c.last_success_at && ` · updated ${ago(c.last_success_at)}`}
                </small>
              </div>
              <StatusBadge c={c} />
            </div>

            {problem && c.status !== "needs_setup" && (
              <p className={`conn-note${c.status === "error" ? " err" : ""}`}>
                <IconAlert size={14} />
                {problem}
              </p>
            )}
            {c.problems.length > 0 && (
              <p className="conn-note">
                <IconAlert size={14} />
                {c.problems.length === 1 ? "One channel couldn't be read" : `${c.problems.length} channels couldn't be read`}. Invite the app to them in Slack, or remove them from the list.
              </p>
            )}

            {editing === c.id ? (
              <SettingsEditor
                org={org}
                c={c}
                name={p.name}
                onDone={(saved) => {
                  setEditing(null);
                  if (saved) {
                    notify(c.status === "needs_setup" ? `Bringing in from ${p.name}. This can take a few minutes.` : "Changes saved");
                    reload();
                  }
                }}
              />
            ) : (
              manage && (
                <div className="conn-actions">
                  {needsReconnect ? (
                    <button type="button" className="primary small" onClick={() => reconnect(c)} disabled={!!busy || !p.available}>
                      {busy === `reconnect:${c.id}` && <IconSpinner size={14} />}
                      Reconnect
                    </button>
                  ) : c.status === "needs_setup" ? (
                    <button type="button" className="primary small" onClick={() => setEditing(c.id)} disabled={!!busy}>
                      Choose what to include
                    </button>
                  ) : (
                    <button type="button" className="ghost small" onClick={() => setEditing(c.id)} disabled={!!busy}>
                      Choose what to include
                    </button>
                  )}
                  {c.status === "active" && c.allowed && (
                    <button type="button" className="quiet small" onClick={() => syncNow(c)} disabled={!!busy}>
                      {busy === `sync:${c.id}` ? <IconSpinner size={14} /> : <IconRefresh size={14} />}
                      Update now
                    </button>
                  )}
                  {(c.status === "active" || c.status === "paused") && (
                    <button type="button" className="quiet small" onClick={() => pause(c, c.status === "active")} disabled={!!busy}>
                      {busy === `pause:${c.id}` ? <IconSpinner size={14} /> : c.status === "active" ? <IconPause size={14} /> : <IconPlay size={14} />}
                      {c.status === "active" ? "Pause" : "Resume"}
                    </button>
                  )}
                  <button type="button" className="danger small conn-disconnect" onClick={() => disconnect(c)} disabled={!!busy}>
                    {busy === `delete:${c.id}` ? <IconSpinner size={14} /> : <IconTrash size={14} />}
                    Disconnect
                  </button>
                </div>
              )
            )}
          </section>
        );
      })}

      {!p.available ? (
        <p className="conn-note">
          <IconAlert size={14} />
          Not available yet. {canManage ? `Your technical team needs to finish setting up ${p.name} on the server.` : "Ask your administrator."}
        </p>
      ) : !p.allowed ? (
        mine.length === 0 && (
          <p className="conn-note">
            <IconLock size={14} />
            Turned off by your administrator.
          </p>
        )
      ) : (
        canConnect && (
          <div className="conn-connect">
            {folders.length > 1 && (
              <label className="conn-folder">
                <small className="muted">{personal ? "Search them in" : "Make it searchable in"}</small>
                <Select
                  size="sm"
                  ariaLabel="Folder"
                  value={folder}
                  onChange={setFolder}
                  options={folders.map((w) => ({ value: w.id, label: w.name }))}
                />
              </label>
            )}
            <button type="button" className={mine.length ? "ghost small" : "primary small"} onClick={connect} disabled={!!busy || !folder}>
              {busy === "connect" && <IconSpinner size={14} />}
              {mine.length ? `Connect another ${p.name} account` : `Connect ${p.name}`}
            </button>
          </div>
        )
      )}
      {!personal && !canManage && mine.length === 0 && p.available && p.allowed && (
        <p className="muted conn-hint">An administrator can connect {p.name} for your company.</p>
      )}

      {error && (
        <div className="alert">
          <IconAlert size={16} />
          <span style={{ flex: 1 }}>{error}</span>
          <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label="Dismiss">
            <IconX size={14} />
          </button>
        </div>
      )}
    </article>
  );
}

/* ───────────── Page ───────────── */

function ConnectionsView() {
  const { org } = useParams<{ org: string }>();
  const search = useSearchParams();
  const router = useRouter();
  const { org: orgInfo } = useOrg();
  const [data, setData] = useState<Catalog | null | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [policyBusy, setPolicyBusy] = useState(false);
  const clearToast = useCallback(() => setToast(null), []);

  const load = useCallback(() => {
    return api<Catalog>(`organizations/${org}/connectors`)
      .then((d) => {
        setData(d);
        setError(null);
        return d;
      })
      .catch((e: Error) => {
        setData((cur) => cur ?? null);
        setError(e.message);
        return null;
      });
  }, [org]);

  // Vuelta de /connect/callback: abre la configuración si falta elegir qué traer.
  useEffect(() => {
    const connected = search.get("connected");
    load().then((d) => {
      if (!connected || !d) return;
      const c = d.connectors.find((x) => x.id === connected);
      if (c) {
        const name = d.providers.find((p) => p.id === c.provider)?.name ?? "The app";
        if (c.status === "needs_setup") {
          setEditing(c.id);
          setToast(`${name} connected. Choose what to include.`);
        } else {
          setToast(`${name} connected. Items will appear in a few minutes.`);
        }
      }
      router.replace(`/app/${org}/connections`, { scroll: false });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [org]);

  // Mientras algo se está actualizando, refresca el estado cada pocos segundos.
  const busy = data?.connectors.some((c) => c.status === "active" && c.allowed && (c.syncing || !c.last_success_at));
  useEffect(() => {
    if (!busy || editing) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [busy, editing, load]);

  const byProvider = useMemo(() => {
    const m = new Map<ProviderId, Connection[]>();
    for (const c of data?.connectors ?? []) m.set(c.provider, [...(m.get(c.provider) ?? []), c]);
    return m;
  }, [data]);

  async function setAllowed(id: ProviderId, on: boolean) {
    if (!data) return;
    const allowed = data.providers.filter((p) => (p.id === id ? on : p.allowed)).map((p) => p.id);
    setPolicyBusy(true);
    try {
      await api(`organizations/${org}/connectors/policy`, { method: "PUT", body: { allowed } });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPolicyBusy(false);
    }
  }

  const personal = data?.providers.filter((p) => p.scope === "personal") ?? [];
  const company = data?.providers.filter((p) => p.scope === "organization") ?? [];
  const card = (p: Provider) => (
    <AppCard
      key={p.id}
      org={org}
      p={p}
      conns={byProvider.get(p.id) ?? []}
      canManage={!!data?.can_manage_company}
      editing={editing}
      setEditing={setEditing}
      reload={load}
      notify={setToast}
    />
  );

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section="Connected apps" context={orgInfo?.name} icon={IconBuilding} />
      </header>
      <div className="main">
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>Connected apps</h1>
            <p className="sub">Bring email, chat and tasks into search. ragsis keeps a private copy, updates it regularly and cites the original in every answer.</p>
          </div>
        </header>

        {data?.demo && (
          <p className="conn-note conn-demo">
            <IconAlert size={14} />
            Demo mode: connections use sample data, not real accounts.
          </p>
        )}
        {error && (
          <div className="alert" style={{ marginBottom: 16 }}>
            <IconAlert size={16} />
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label="Dismiss">
              <IconX size={14} />
            </button>
          </div>
        )}

        {data === undefined ? (
          <SkeletonStatus label="Loading connected apps…">
            <div className="conn-grid">
              {[0, 1, 2].map((i) => (
                <div key={i} className="card conn-card">
                  <Skel w={36} h={36} r={10} />
                  <Skel w="70%" h={14} />
                  <Skel w="90%" h={12} />
                </div>
              ))}
            </div>
          </SkeletonStatus>
        ) : (
          data && (
            <>
              <section className="conn-section" aria-labelledby="conn-personal">
                <h3 id="conn-personal" className="conn-section-title">
                  <IconUser size={15} />
                  Just for you
                </h3>
                <div className="conn-grid">{personal.map(card)}</div>
              </section>
              <section className="conn-section" aria-labelledby="conn-company">
                <h3 id="conn-company" className="conn-section-title">
                  <IconBuilding size={15} />
                  For your company
                </h3>
                <div className="conn-grid">{company.map(card)}</div>
              </section>

              {data.can_manage_company && (
                <Disclosure title="Apps people can connect" hint="Turning an app off pauses its updates. Nothing is removed.">
                  <div className="stack" style={{ gap: 10 }}>
                    {data.providers.map((p) => (
                      <Checkbox
                        key={p.id}
                        checked={p.allowed}
                        onChange={(v) => !policyBusy && setAllowed(p.id, v)}
                        label={`${p.name}${p.scope === "personal" ? " (each person connects their own)" : ""}`}
                      />
                    ))}
                  </div>
                </Disclosure>
              )}
            </>
          )
        )}
      </div>
      <Toast message={toast} onDone={clearToast} ms={3600} />
    </div>
  );
}

export default function ConnectionsPage() {
  return (
    <Suspense>
      <ConnectionsView />
    </Suspense>
  );
}
