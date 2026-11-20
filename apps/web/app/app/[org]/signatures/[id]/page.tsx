"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { fileSha256 } from "@/lib/signature-proof";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { EnvelopeSkeleton } from "@/components/skeletons";
import { IconAlert, IconCheck, IconFile, IconLock, IconSignature, IconSpinner, IconStop, IconX } from "@/components/icons";
import { Checkbox, Toast } from "@/components/motion";
import { TextField, useConfirm } from "@/components/ui";
import { SignatureForm, type SignatureDecision } from "@/components/SignatureForm";
import { StateBadge, when } from "../../workflows/shared";
import { humanize } from "@/lib/plain";
import { useT } from "@/lib/use-t";

import { dateLocale } from "@/lib/i18n";
interface Envelope {
  id: string;
  run_id: string | null;
  provider: string;
  external_id: string | null;
  state: string;
  subject: string | null;
  documents: { title: string; version_id: string; sha256: string; filename: string }[];
  signers: { name: string; email: string }[];
  responses: { signer_email: string; decision: string; typed_name: string; signed_at: string }[];
  evidence: { signed: boolean; certificate: boolean; signed_sha256: string | null; certificate_sha256: string | null; stamped: boolean | null; source: string | null };
  events: { event_id: string; type: string; occurred_at: string }[];
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
  voided_reason: string | null;
  awaiting_me: boolean;
  can_void: boolean;
  local_signing: boolean;
  native_signing: boolean;
  consent_text: string | null;
  action_hash: string | null;
  invitations?: { signer_email: string; sent_at: string | null; opened_at: string | null; expires_at: string; attempts: number }[];
}

export default function EnvelopePage() {
  const t = useT();
  const { org, id } = useParams<{ org: string; id: string }>();
  const confirm = useConfirm();
  const [env, setEnv] = useState<Envelope | null>(null);
  const [typed, setTyped] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ title: string; url: string } | null>(null);
  const [invitationLink, setInvitationLink] = useState<string | null>(null);
  const [verification, setVerification] = useState<string | null>(null);
  const clearNotice = useCallback(() => setNotice(null), []);

  const load = useCallback(async () => {
    try {
      setEnv(await api<Envelope>(`organizations/${org}/signatures/${id}`));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [org, id]);

  useEffect(() => {
    load();
  }, [load]);

  if (!env) {
    if (!error) return <EnvelopeSkeleton />;
    return (
      <div className="page">
        <div className="main">
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        </div>
      </div>
    );
  }

  async function respond(decision: "sign" | "decline") {
    if (decision === "decline" && !(await confirm({ title: t("Decline to sign?"), body: t("The request closes for everyone and the workflow stops."), confirmLabel: t("Decline"), tone: "danger" }))) return;
    setBusy(decision);
    setError(null);
    try {
      await api(`organizations/${org}/signatures/${id}/local-sign`, { method: "POST", body: { decision, typed_name: typed, consent: true } });
      setNotice(decision === "sign" ? t("Signed") : t("Declined"));
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function download(kind: "signed" | "certificate") {
    try {
      const r = await api<{ url: string }>(`organizations/${org}/signatures/${id}/evidence/${kind}`);
      window.location.href = r.url;
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function nativeResponse(body: SignatureDecision) {
    setError(null);
    try {
      await api(`organizations/${org}/signatures/${id}/respond`, { method: "POST", body });
      setNotice(body.decision === "sign" ? t("Signature recorded") : t("You declined to sign"));
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function reviewDocument(doc: Envelope["documents"][number]) {
    setError(null);
    setBusy(doc.version_id);
    try {
      const { url } = await api<{ url: string }>(`organizations/${org}/signatures/${id}/documents/${doc.version_id}`);
      setPreview({ title: doc.title, url });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function send() {
    if (!env?.action_hash || !(await confirm({ title: t("Approve and send for signature?"), body: t("You approve these exact PDFs and signers. Signers can sign right away."), confirmLabel: t("Approve and send") }))) return;
    setBusy("send");
    setError(null);
    try {
      await api(`organizations/${org}/signatures/${id}/send`, { method: "POST", body: { action_hash: env.action_hash } });
      setNotice(t("Sent for signature"));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function remind(email: string) {
    setBusy(email);
    setError(null);
    setInvitationLink(null);
    try {
      const res = await api<{ development_url?: string }>(`organizations/${org}/signatures/${id}/remind`, { method: "POST", body: { email } });
      setInvitationLink(res.development_url ?? null);
      setNotice(res.development_url ? t("Development link ready") : t("Invitation queued"));
      await load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function verifyPdf(file: File) {
    setVerification("Checking document…");
    try {
      const hash = await fileSha256(file);
      setVerification(hash === env?.evidence.signed_sha256 ? "This PDF matches the signed copy." : "This PDF differs from the signed copy.");
    } catch {
      setVerification("This file could not be checked.");
    }
  }

  async function voidEnvelope() {
    if (!(await confirm({ title: t("Cancel this signature request?"), body: t("Signers can no longer sign, and any workflow waiting on it stops."), confirmLabel: t("Void"), tone: "danger" }))) return;
    try {
      await api(`organizations/${org}/signatures/${id}/void`, { method: "POST", body: { reason: "voided by user" } });
      setNotice(t("Signature request cancelled"));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const responded = (email: string) => env.responses.find((r) => r.signer_email === email);

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs
          section={t("Signatures & sharing")}
          href={`/app/${org}/signatures`}
          context={env.subject ?? env.documents.map((d) => d.title).join(", ")}
          icon={IconSignature}
        />
        {env.can_void && (
          <button type="button" className="primary small" onClick={voidEnvelope}>
            <IconStop size={14} />{t("Cancel request")}</button>
        )}
      </header>

      <div className="main" style={{ maxWidth: 1240 }}>
        <header className="page-head" style={{ marginBottom: 20 }}>
          <div>
            <h1>{env.subject ?? t("Signature request")}</h1>
            <div className="row" style={{ gap: 6, marginTop: 6 }}>
              <StateBadge state={env.state} />
              <span className="badge">{env.provider === "native" ? t("Ragsis Sign") : t("Test signature")}</span>
              {env.run_id && (
                <Link href={`/app/${org}/activity/${env.run_id}`} className="badge accent" style={{ textDecoration: "none" }}>{t("From a workflow")}</Link>
              )}
            </div>
          </div>
          {env.action_hash && <button type="button" className="primary" onClick={send} disabled={!!busy}>{t("Approve and send")}</button>}
        </header>
        {env.provider === "native" && env.state === "DRAFT" && !env.run_id && !env.action_hash && (
          <p className="notice" style={{ marginBottom: 16 }}>{t("Another signatory or an administrator must approve and send this draft.")}</p>
        )}

        {error && (
          <div className="alert" style={{ marginBottom: 16 }}>
            <IconAlert size={16} />
            <span style={{ flex: 1 }}>{error}</span>
            <button type="button" className="quiet icon small" onClick={() => setError(null)} aria-label={t("Dismiss")}>
              <IconX size={14} />
            </button>
          </div>
        )}

        <div className="ed">
          <div className="stack">
            {env.awaiting_me && env.local_signing && (
              <section className="card ed-section ceremony">
                <header>
                  <div>
                    <h2>{t("Your signature is requested")}</h2>
                    <p>{t("Review the documents below. You sign as yourself; nobody — including an AI agent — can sign for you.")}</p>
                  </div>
                </header>
                <div className="notice">
                  <IconAlert size={16} />{t("Test mode: your answer is recorded in the app, but it isn't a legally binding signature.")}</div>
                <TextField label={t("Type your full name")} value={typed} maxLength={120} onChange={(e) => setTyped(e.target.value)} />
                <Checkbox checked={consent} onChange={setConsent} label={t("I agree to sign electronically and confirm I reviewed the listed documents.")} />
                <div className="row">
                  <button type="button" className="primary" disabled={!consent || typed.trim().length < 2 || !!busy} onClick={() => respond("sign")}>
                    {busy === "sign" ? <IconSpinner size={14} /> : <IconSignature size={16} />}{t("Sign")}</button>
                  <button type="button" className="ghost" disabled={typed.trim().length < 2 || !!busy} onClick={() => respond("decline")}>{t("Decline")}</button>
                </div>
              </section>
            )}

            <section className="card ed-section">
              <header>
                <h2>{t("Documents")}</h2>
              </header>
              <div className="ceremony">
                {env.documents.map((d) => (
                  <div className="doc-row" key={d.version_id}>
                    <IconFile size={16} />
                    <span>
                      {d.title} <span className="muted">· {d.filename}</span>
                    </span>
                    <span className="badge" data-tip={t("Locked for signing. Any change to the file would be detected. Fingerprint: {v1}…", { v1: d.sha256.slice(0, 16) })}>
                      <IconLock size={12} />{t("Locked")}</span>
                    {env.provider === "native" && <button type="button" className="ghost small" onClick={() => reviewDocument(d)} disabled={!!busy}>{t("Review PDF")}</button>}
                  </div>
                ))}
                {preview && (
                  <div className="stack">
                    <iframe key={preview.url} title={preview.title} src={preview.url} referrerPolicy="no-referrer" style={{ width: "100%", minHeight: "min(65vh, 560px)", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }} />
                    <a href={preview.url} target="_blank" rel="noreferrer">{t("Open")}{" "}{preview.title}{" "}{t("in a new tab")}</a>
                  </div>
                )}
              </div>
            </section>

            {env.awaiting_me && env.native_signing && env.consent_text && (
              <section className="card ed-section ceremony">
                <header><div><h2>{t("Your signature")}</h2><p>{t("Review each PDF above and sign using your account.")}</p></div></header>
                <SignatureForm consentText={env.consent_text} onRespond={nativeResponse} personalSignaturesHref={`/app/${org}/signatures/mine`} />
              </section>
            )}

            <section className="card ed-section">
              <header>
                <h2>{t("Signers")}</h2>
              </header>
              <ul className="signer-list">
                {env.signers.map((s) => {
                  const r = responded(s.email);
                  const invite = env.invitations?.find((item) => item.signer_email === s.email);
                  const expired = invite && new Date(invite.expires_at).getTime() < Date.now();
                  return (
                    <li key={s.email}>
                      <span className="meta">
                        <strong style={{ fontWeight: 500 }}>{s.name}</strong>
                        <small>{s.email}</small>
                        {invite && !r && <small>{expired ? t("Invitation expired") : invite.opened_at ? t("Opened {v1}", { v1: when(invite.opened_at) }) : invite.sent_at ? t("Emailed {v1}", { v1: when(invite.sent_at) }) : invite.attempts >= 5 ? t("Email delivery failed") : t("Invitation pending")}</small>}
                      </span>
                      {r ? (
                        <span className={`badge ${r.decision === "signed" ? "ok" : "err"}`}>
                          {r.decision === "signed" ? <IconCheck size={12} /> : <IconX size={12} />}
                          {r.decision === "signed" ? t("Signed") : r.decision === "declined" ? t("Declined") : r.decision} · {when(r.signed_at)}
                        </span>
                      ) : (
                        invite && env.can_void && ["SENT", "DELIVERED"].includes(env.state) ? (
                          <button type="button" className="ghost small" disabled={!!busy} onClick={() => remind(s.email)}>{expired ? t("Renew invitation") : t("Resend invitation")}</button>
                        ) : <span className="badge">{env.state === "DRAFT" ? t("Not sent yet") : t("Waiting")}</span>
                      )}
                    </li>
                  );
                })}
              </ul>
              {invitationLink && <p className="notice"><a href={invitationLink} target="_blank" rel="noreferrer">{t("Open test invitation")}</a></p>}
            </section>
          </div>

          <aside className="ed-side">
            <section className="card ed-section">
              <header>
                <h2>{t("Signed documents")}</h2>
              </header>
              {env.state === "COMPLETED" ? (
                <div className="stack" style={{ gap: 10 }}>
                  <button type="button" className="ghost small" disabled={!env.evidence.signed} onClick={() => download("signed")}>
                    {env.evidence.stamped === false ? t("Download original document") : t("Download signed document")}
                  </button>
                  <button type="button" className="ghost small" disabled={!env.evidence.certificate} onClick={() => download("certificate")}>
                    {env.evidence.stamped === false ? t("Download signing record") : t("Download certificate")}
                  </button>
                  {env.evidence.stamped === false && <p className="muted" style={{ fontSize: 12.5 }}>{t("This request was completed in test mode. The record shows the answers from that test.")}</p>}

                  {env.provider === "native" && env.evidence.signed_sha256 && (
                    <div className="stack" style={{ gap: 6 }}>
                      <label htmlFor="verify-signed-pdf">{t("Check a copy you have: choose the PDF to confirm it matches the signed one")}</label>
                      <input id="verify-signed-pdf" type="file" accept="application/pdf,.pdf" onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void verifyPdf(file);
                      }} />
                      {verification && <p role="status">{verification}</p>}
                    </div>
                  )}
                </div>
              ) : (
                <p className="muted" style={{ fontSize: 13 }}>{t("Available after every signer has signed.")}</p>
              )}
            </section>
            <section className="card ed-section">
              <header>
                <h2>{t("Timeline")}</h2>
              </header>
              <dl className="kv-list">
                <dt>{t("Created")}</dt>
                <dd>{when(env.created_at)}</dd>
                <dt>{t("Sent")}</dt>
                <dd>{when(env.sent_at)}</dd>
                <dt>{t("Completed")}</dt>
                <dd>{when(env.completed_at)}</dd>
                {env.voided_reason && (
                  <>
                    <dt>{t("Cancelled")}</dt>
                    <dd>{env.voided_reason}</dd>
                  </>
                )}
              </dl>
              <ul className="events">
                {env.events.map((e) => (
                  <li key={e.event_id}>
                    <time>{new Date(e.occurred_at).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" })}</time>
                    <span>{humanize(e.type)}</span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>
      <Toast message={notice} onDone={clearNotice} />
    </div>
  );
}
