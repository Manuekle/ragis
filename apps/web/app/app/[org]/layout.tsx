"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type Workspace } from "@/lib/api";
import { AppErrorState, requestErrorKind } from "@/components/AppState";
import { IconActivity, IconAgent, IconSignature, IconAlert, IconInbox, IconWorkflow, IconArrowRight, IconChart, IconChat, IconCheck, IconRocket, IconChevronsUpDown, IconFiles, IconFolder, IconLogout, IconPlug, IconShield, IconSparkles, IconSwitch } from "@/components/icons";
import { SoftText, useDropdown } from "@/components/motion";
import { Skel, SkeletonStatus } from "@/components/skeletons";
import { ConfirmProvider, Avatar } from "@/components/ui";
import { ThemeToggle } from "@/components/ThemeToggle";
import "./studio.css";
import "./workflows.css";

interface OrgInfo {
  id: string;
  name: string;
  role: string;
  plan: { id: string; rerank_enabled: boolean };
}

interface Ctx {
  org: OrgInfo | null;
  loading: boolean;
  workspaces: Workspace[];
  workspaceId: string;
  setWorkspaceId: (id: string) => void;
  setWorkspaceHasDocuments: (id: string, hasDocuments: boolean) => void;
}

const OrgContext = createContext<Ctx>({ org: null, loading: true, workspaces: [], workspaceId: "", setWorkspaceId: () => undefined, setWorkspaceHasDocuments: () => undefined });
export const useOrg = () => useContext(OrgContext);

export default function OrgLayout({ children }: { children: React.ReactNode }) {
  const { org: orgId } = useParams<{ org: string }>();
  const path = usePathname();
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceIdState] = useState("");
  const [error, setError] = useState<Error | null>(null);
  const [revision, setRevision] = useState(0);
  const errorKind = requestErrorKind(error);
  const loading = !org && !error;
  const [setup, setSetup] = useState<{ status: string; completed_steps: number[]; can_edit: boolean } | null>(null);
  const [inboxCount, setInboxCount] = useState(0);
  const wsMenu = useDropdown();
  const orgMenu = useDropdown();

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([api<OrgInfo>(`organizations/${orgId}`), api<{ workspaces: Workspace[] }>(`organizations/${orgId}/workspaces`)])
      .then(([o, w]) => {
        if (!active) return;
        setOrg(o);
        setWorkspaces(w.workspaces);
        let saved = "";
        try {
          saved = localStorage.getItem(`ragsis:ws:${orgId}`) ?? "";
        } catch {}
        setWorkspaceIdState(w.workspaces.find((x) => x.id === saved)?.id ?? w.workspaces[0]?.id ?? "");
      })
      .catch((e: Error) => { if (active) setError(e); });
    return () => { active = false; };
  }, [orgId, revision]);

  // Contador de Inbox: se refresca al navegar y cuando una pantalla decide una aprobación.
  useEffect(() => {
    const refresh = () =>
      api<{ counts: { actionable: number } }>(`organizations/${orgId}/inbox`)
        .then((r) => setInboxCount(r.counts.actionable))
        .catch(() => setInboxCount(0));
    window.addEventListener("ragsis:inbox", refresh);
    return () => window.removeEventListener("ragsis:inbox", refresh);
  }, [orgId]);

  // Estado del onboarding: solo orienta (banner); nunca bloquea la app.
  useEffect(() => {
    api<{ status: string; completed_steps: number[]; can_edit: boolean }>(`organizations/${orgId}/onboarding`)
      .then(setSetup)
      .catch(() => setSetup(null));
    api<{ counts: { actionable: number } }>(`organizations/${orgId}/inbox`)
      .then((r) => setInboxCount(r.counts.actionable))
      .catch(() => setInboxCount(0));
  }, [orgId, path]);

  const setWorkspaceId = (id: string) => {
    setWorkspaceIdState(id);
    try {
      localStorage.setItem(`ragsis:ws:${orgId}`, id);
    } catch {}
  };

  const setWorkspaceHasDocuments = useCallback((id: string, hasDocuments: boolean) => {
    setWorkspaces((current) => {
      const workspace = current.find((w) => w.id === id);
      if (!workspace || workspace.has_documents === hasDocuments) return current;
      return current.map((w) => w.id === id ? { ...w, has_documents: hasDocuments } : w);
    });
  }, []);

  const isAdmin = org?.role === "owner" || org?.role === "admin";
  const isAsk = path?.endsWith("/ask") ?? false;
  const main = [
    { href: `/app/${orgId}/ask`, label: "Ask", Icon: IconChat },
    { href: `/app/${orgId}/library`, label: "Library", Icon: IconFiles },
    { href: `/app/${orgId}/connections`, label: "Connected apps", Icon: IconPlug },
    { href: `/app/${orgId}/agents`, label: "Agent Studio", Icon: IconAgent },
    { href: `/app/${orgId}/workflows`, label: "Workflows", Icon: IconWorkflow },
    { href: `/app/${orgId}/inbox`, label: "Inbox", Icon: IconInbox, count: inboxCount },
    { href: `/app/${orgId}/activity`, label: "Activity", Icon: IconActivity },
    { href: `/app/${orgId}/signatures`, label: "Signatures", Icon: IconSignature },
  ];
  const admin = isAdmin
    ? [
        { href: `/app/${orgId}/onboarding`, label: "Setup", Icon: IconRocket },
        { href: `/app/${orgId}/usage`, label: "Usage & costs", Icon: IconChart },
        { href: `/app/${orgId}/admin`, label: "Governance", Icon: IconShield },
      ]
    : [];
  const wsName = workspaces.find((w) => w.id === workspaceId)?.name;
  const showSetup = !!setup?.can_edit && setup.status !== "COMPLETED" && !(path?.includes("/onboarding") ?? false);
  const setupDone = setup ? new Set(setup.completed_steps).size : 0;

  // Sliding active pill: measured from the active link, tweened between positions.
  const navRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const pill = pillRef.current;
    if (!nav || !pill) return;
    const place = (animate: boolean) => {
      const active = nav.querySelector<HTMLAnchorElement>("a.active");
      if (!active) {
        pill.style.opacity = "0";
        return;
      }
      if (!animate) pill.style.transition = "none";
      pill.style.opacity = "1";
      pill.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
      pill.style.width = `${active.offsetWidth}px`;
      pill.style.height = `${active.offsetHeight}px`;
      if (!animate) {
        void pill.offsetWidth;
        pill.style.transition = "";
      }
    };
    place(placed.current);
    placed.current = true;
    const onResize = () => place(false);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [path, isAdmin]);

  return (
    <OrgContext.Provider value={{ org, loading, workspaces, workspaceId, setWorkspaceId, setWorkspaceHasDocuments }}>
      <ConfirmProvider>
      <div className="shell">
        <aside className="side">
          <div className="side-org">
            {loading ? <Skel w={28} h={28} r={999} /> : <Avatar name={org?.name ?? "·"} size="sm" />}
            {loading ? (
              <SkeletonStatus label="Loading organization…" className="side-org-meta">
                <div className="stack" style={{ gap: 4 }}>
                  <Skel w={98} h={12} />
                  <Skel w={64} h={10} />
                </div>
              </SkeletonStatus>
            ) : (
              <span className="side-org-meta">
                <strong>{org?.name ?? "Organization"}</strong>
                {org && <small>{org.role} · {org.plan?.id ?? "—"} plan</small>}
              </span>
            )}
            <div className="side-org-menu" ref={orgMenu.ref}>
              <button
                type="button"
                className="side-org-btn"
                aria-label="Organization options"
                aria-haspopup="menu"
                aria-expanded={orgMenu.isOpen}
                onClick={orgMenu.toggle}
              >
                <IconChevronsUpDown size={15} />
              </button>
              <div className={`menu ${orgMenu.cls}`} role="menu" data-origin="top-right" inert={!orgMenu.isOpen}>
                <div className="menu-label">{org?.name ?? "Organization"}</div>
                <a className="menu-item" href="/app" role="menuitem">
                  <IconSwitch size={15} />
                  Switch organization
                </a>
                <div className="menu-sep" />
                <a className="menu-item danger" href="/api/auth/logout" role="menuitem">
                  <IconLogout size={15} />
                  Sign out
                </a>
              </div>
            </div>
          </div>

          <div className="switcher" ref={wsMenu.ref}>
            <span className="side-label">Workspace</span>
            <button
              type="button"
              className="switcher-btn"
              aria-label="Switch workspace"
              aria-haspopup="menu"
              aria-expanded={wsMenu.isOpen}
              onClick={wsMenu.toggle}
            >
              <IconFolder size={15} />
              <span className="meta">
                {loading ? (
                  <>
                    <span className="sr-only">Loading workspaces…</span>
                    <Skel w={84} h={12} />
                  </>
                ) : <strong>{wsName ?? "No workspace"}</strong>}
              </span>
              <IconChevronsUpDown size={15} />
            </button>
            <div className={`menu ${wsMenu.cls}`} role="menu" data-origin="top-left" inert={!wsMenu.isOpen}>
              <div className="menu-label">Workspaces</div>
              {workspaces.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={w.id === workspaceId}
                  className="menu-item"
                  onClick={() => {
                    setWorkspaceId(w.id);
                    wsMenu.close();
                  }}
                >
                  {w.name}
                  {w.id === workspaceId && <IconCheck className="check" size={15} />}
                </button>
              ))}
            </div>
          </div>

          <div className="nav" ref={navRef} aria-label="Main navigation">
            <span className="nav-pill" ref={pillRef} aria-hidden="true" />
            <div className="nav-label">Workspace</div>
            {main.map(({ href, label, Icon, count }) => (
              <Link key={href} href={href} className={path?.startsWith(href) ? "active" : ""} aria-current={path?.startsWith(href) ? "page" : undefined}>
                <Icon size={18} variant={path?.startsWith(href) ? "duotone" : "stroke"} />
                {label}
                {!!count && (
                  <span className="nav-count" aria-label={`${count} pending`}>
                    <SoftText text={String(count)} />
                  </span>
                )}
              </Link>
            ))}
            {admin.length > 0 && <div className="nav-label">Administration</div>}
            {admin.map(({ href, label, Icon }) => (
              <Link key={href} href={href} className={path?.startsWith(href) ? "active" : ""} aria-current={path?.startsWith(href) ? "page" : undefined}>
                <Icon size={18} variant={path?.startsWith(href) ? "duotone" : "stroke"} />
                {label}
              </Link>
            ))}
          </div>

          <div className="side-foot">
            {isAdmin && org?.plan && org.plan.id !== "private" && (
              <Link href={`/app/${orgId}/usage`} className="btn-upgrade side-upgrade">
                <IconSparkles size={15} variant="duotone" />
                Upgrade plan
              </Link>
            )}
            <div className="theme-row">
              <span className="side-label">Theme</span>
              <ThemeToggle />
            </div>
          </div>
        </aside>
        <div className={`panel${isAsk ? " panel-chat" : ""}`} id="panel">
          {showSetup && (
            <div className="setup-banner" role="status">
              <IconRocket size={16} variant="duotone" />
              <strong>{setup!.status === "NEEDS_REVIEW" ? "Your profile changed" : "Finish setting up"}</strong>
              <span>{setup!.status === "NEEDS_REVIEW" ? "Review the new space and agent suggestions." : `${setupDone} of 9 steps done`}</span>
              {setup!.status !== "NEEDS_REVIEW" && (
                <span className="meter-inline" aria-hidden="true">
                  <span style={{ width: `${(setupDone / 9) * 100}%` }} />
                </span>
              )}
              <Link href={`/app/${orgId}/onboarding`}>
                {setup!.status === "NEEDS_REVIEW" ? "Review" : "Continue"}
                <IconArrowRight size={14} />
              </Link>
            </div>
          )}
          {errorKind ? (
            <div className="main">
              <AppErrorState kind={errorKind} onRetry={() => setRevision((value) => value + 1)} />
            </div>
          ) : error ? (
            <div className="main">
              <div className="alert" role="alert">
                <IconAlert size={16} />
                {error.message}
              </div>
            </div>
          ) : (
            children
          )}
        </div>
      </div>
      </ConfirmProvider>
    </OrgContext.Provider>
  );
}
