"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { IconAlert, IconBuilding, IconCopy, IconSignature, IconX } from "@/components/icons";
import { StateIllustration } from "@/components/AppState";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { SoftText, Toast } from "@/components/motion";
import { Skel, SkeletonRunRows, SkeletonStatus } from "@/components/skeletons";
import { useConfirm } from "@/components/ui";
import { useOrg } from "../layout";
import { StateBadge, ago, when } from "../workflows/shared";

interface Envelope {
  id: string;
  run_id: string | null;
  provider: string;
  subject: string | null;
  state: string;
  documents: { title: string }[];
  signers: { name: string; email: string }[];
  created_at: string;
  workflow_name: string | null;
  awaiting_me: boolean;
}
interface Share {
  id: string;
  run_id: string | null;
  artifact: string;
  title: string;
  recipients: string[];
  expires_at: string;
  status: "active" | "expired" | "revoked";
  access_count: number;
  last_access_at: string | null;
  approved_by_email: string | null;
  can_manage: boolean;
}

type Tab = "envelopes" | "shares";

export default function SignaturesPage() {
  const { org } = useParams<{ org: string }>();
  const { org: orgInfo } = useOrg();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>("envelopes");
  const [envelopes, setEnvelopes] = useState<Envelope[] | null>();
  const [provider, setProvider] = useState("");
  const [canCreate, setCanCreate] = useState(false);
  const [shares, setShares] = useState<Share[]>([]);
  const [revealed, setRevealed] = useState<{ id: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);

  const load = useCallback(async () => {
    try {
      const [e, s] = await Promise.all([api<{ provider: string; can_create: boolean; envelopes: Envelope[] }>(`organizations/${org}/signatures`), api<{ shares: Share[] }>(`organizations/${org}/shares`)]);
      setEnvelopes(e.envelopes);
      setProvider(e.provider);
      setCanCreate(e.can_create ?? false);
      setShares(s.shares);
    } catch (err) {
      setEnvelopes((current) => current === undefined ? null : current);
      setError((err as Error).message);
    }
  }, [org]);

  useEffect(() => {
    if (window.location.hash === "#shares") setTab("shares");
    load();
  }, [load]);

  async function reveal(s: Share) {
    const ok = await confirm({ title: "Generate a new link?", body: "The link is shown once. Any link generated before stops working. Send it only to the listed recipients." });
    if (!ok) return;
    try {
      const r = await api<{ url: string }>(`organizations/${org}/shares/${s.id}/reveal`, { method: "POST" });
      setRevealed({ id: s.id, url: r.url });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function revoke(s: Share) {
    if (!(await confirm({ title: "Revoke this link?", body: "Recipients lose access immediately. This can't be undone.", confirmLabel: "Revoke", tone: "danger" }))) return;
    try {
      await api(`organizations/${org}/shares/${s.id}/revoke`, { method: "POST" });
      setNotice("Link revoked");
      setRevealed(null);
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section="Signatures & sharing" context={orgInfo?.name} icon={IconBuilding} />
      </header>
      <div className="main">
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>Signatures & sharing</h1>
            <p className="sub">Send documents for signature, track each signer and share approved files with expiring links.</p>
          </div>
          <div className="row">
            {provider === "native" && <Link className="btn ghost" href={`/app/${org}/signatures/mine`}>My signatures</Link>}
            {canCreate && <Link className="btn primary" href={`/app/${org}/signatures/new`}><IconSignature size={16} /> Request signatures</Link>}
          </div>
        </header>

        {provider === "local" && (
          <div className="notice" style={{ marginBottom: 16 }}>
            <IconAlert size={16} />
            Signatures are in test mode: they work for trying things out but aren't legally binding. Ask your administrator to turn on Ragsis Sign.
          </div>
        )}
        {provider === "disabled" && (
          <div className="notice" style={{ marginBottom: 16 }}>
            <IconAlert size={16} />
            Electronic signatures aren't turned on yet, so signature steps in workflows won't work. Ask your administrator to turn them on.
          </div>
        )}

        <div className="tabs" role="tablist" aria-label="Sections">
          <button type="button" role="tab" aria-selected={tab === "envelopes"} onClick={() => (setTab("envelopes"), history.replaceState(null, "", "#envelopes"))}>
            Signature requests
            {envelopes === undefined ? <Skel w={16} h={13} r={999} /> : envelopes !== null && <span className="count"><SoftText text={String(envelopes.length)} /></span>}
          </button>
          <button type="button" role="tab" aria-selected={tab === "shares"} onClick={() => (setTab("shares"), history.replaceState(null, "", "#shares"))}>
            Shared links
            {envelopes === undefined ? <Skel w={16} h={13} r={999} /> : envelopes !== null && <span className="count"><SoftText text={String(shares.filter((s) => s.status === "active").length)} /></span>}
          </button>
        </div>

        {error && (
          <div className="alert" style={{ marginTop: 16 }}>
            <IconAlert size={16} />
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label="Dismiss">
              <IconX size={14} />
            </button>
          </div>
        )}

        {tab === "envelopes" && envelopes !== null && (
          <section className="card tab-panel" style={{ padding: 0, overflow: "hidden", marginTop: 20 }}>
            {envelopes === undefined ? (
              <SkeletonStatus label="Loading signature requests…">
                <SkeletonRunRows />
              </SkeletonStatus>
            ) : envelopes.length === 0 ? (
              <div className="empty">
                <StateIllustration kind="signatures" />
                <strong>No signature requests yet</strong>
                <span>Request signatures here, or run a workflow that includes a signature step.</span>
              </div>
            ) : (
              envelopes.map((e) => (
                <Link key={e.id} href={`/app/${org}/signatures/${e.id}`} className="run-row">
                  <span className="meta">
                    <strong>{e.subject ?? e.documents.map((d) => d.title).join(", ")}</strong>
                    <small>
                      {e.signers.map((s) => s.name).join(", ")} · {e.workflow_name ?? "sent by hand"} · {ago(e.created_at)}
                    </small>
                  </span>
                  <span className="side">
                    {e.awaiting_me && <span className="badge warn">Needs your signature</span>}
                    <StateBadge state={e.state} />
                  </span>
                </Link>
              ))
            )}
          </section>
        )}

        {tab === "shares" && envelopes !== null && (
          <section className="tab-panel" style={{ marginTop: 20, paddingTop: 0 }}>
            {revealed && (
              <div className="secret">
                <strong>Copy the link now. It won't be shown again, and earlier links stopped working.</strong>
                <div className="token">
                  <code>{revealed.url}</code>
                  <button type="button" className="quiet icon small" aria-label="Copy link" onClick={() => navigator.clipboard.writeText(revealed.url).then(() => setNotice("Link copied"))}>
                    <IconCopy size={16} />
                  </button>
                </div>
              </div>
            )}
            <div className="card" style={{ padding: 0, overflow: "hidden" }}>
              {envelopes === undefined ? (
                <SkeletonStatus label="Loading shared links…">
                  <SkeletonRunRows />
                </SkeletonStatus>
              ) : shares.length === 0 ? (
                <div className="empty">
                  <StateIllustration kind="signatures" />
                  <strong>No shared links</strong>
                  <span>Links are created by a workflow's share step, after someone approves who receives them.</span>
                </div>
              ) : (
                shares.map((s) => (
                  <div key={s.id} className="run-row">
                    <span className="meta">
                      <strong>{s.title}</strong>
                      <small>
                        To {s.recipients.join(", ")} · approved by {s.approved_by_email ?? "—"} · expires {when(s.expires_at)} · {s.access_count} {s.access_count === 1 ? "download" : "downloads"}
                      </small>
                    </span>
                    <span className="side">
                      <StateBadge state={s.status} />
                      {s.can_manage && s.status === "active" && (
                        <>
                          <button type="button" className="ghost small" onClick={() => reveal(s)}>
                            Get link
                          </button>
                          <button type="button" className="danger small" onClick={() => revoke(s)}>
                            Revoke
                          </button>
                        </>
                      )}
                    </span>
                  </div>
                ))
              )}
            </div>
          </section>
        )}
      </div>
      <Toast message={notice} onDone={clearNotice} />
    </div>
  );
}
