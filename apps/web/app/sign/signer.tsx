"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconFile, IconSignature } from "@/components/icons";
import { SignatureForm, type SignatureDecision } from "@/components/SignatureForm";
import { SoftText } from "@/components/motion";

interface Invitation {
  subject: string | null;
  state: string;
  email: string;
  consent_text: string;
  awaiting_me: boolean;
  documents: { version_id: string; title: string; filename: string }[];
}

async function request<T>(token: string, action: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/signature-guest/${action}`, {
    method: "POST",
    headers: { authorization: `Signature ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message ?? "The request could not be completed.");
  return data;
}

export function GuestSignature() {
  const [token, setToken] = useState("");
  const [invite, setInvite] = useState<Invitation | null>(null);
  const [preview, setPreview] = useState<{ title: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    const key = window.location.hash.slice(1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) {
      setError("Open the personal link from your signature invitation.");
      setLoading(false);
      return;
    }
    setToken(key);
    request<Invitation>(key, "open").then(setInvite).catch((e) => setError(e.message)).finally(() => setLoading(false));
  }, []);

  async function respond(body: SignatureDecision) {
    setError("");
    try {
      const result = await request<{ state: string }>(token, "respond", body);
      setInvite((current) => current && { ...current, state: result.state, awaiting_me: false });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function openDocument(doc: Invitation["documents"][number]) {
    setError("");
    setBusy(doc.version_id);
    try {
      const { url } = await request<{ url: string }>(token, "document", { version_id: doc.version_id });
      setPreview({ url, title: doc.title });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function download() {
    setBusy("signed");
    setError("");
    try {
      window.location.assign((await request<{ url: string }>(token, "signed")).url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="stack" style={{ maxWidth: 880, margin: "0 auto", padding: "clamp(20px, 5vw, 56px)" }}>
      <header className="stack" style={{ gap: 8 }}>
        <span className="row muted"><IconSignature size={18} /> Ragsis Sign</span>
        <h1>{invite?.subject ?? "Review and sign"}</h1>
        {invite && <p className="muted">Signature invitation for {invite.email}</p>}
      </header>
      {error && <p className="alert" role="alert">{error}</p>}
      {loading && <p role="status">Opening your invitation…</p>}
      {invite && (
        <>
          <section className="card stack">
            <h2>Documents</h2>
            {invite.documents.map((doc) => (
              <div className="row" key={doc.version_id}>
                <IconFile size={16} />
                <span style={{ flex: 1 }}>{doc.title}</span>
                <button className="ghost small" type="button" disabled={!!busy} onClick={() => openDocument(doc)}>
                  <SoftText text={busy === doc.version_id ? "Opening…" : "Review PDF"} />
                </button>
              </div>
            ))}
            {preview && (
              <div className="stack">
                <iframe key={preview.url} title={preview.title} src={preview.url} referrerPolicy="no-referrer" style={{ width: "100%", minHeight: "min(65vh, 560px)", border: "1px solid var(--border)", borderRadius: "var(--r-md)" }} />
                <a href={preview.url} target="_blank" rel="noreferrer">Open {preview.title} in a new tab</a>
              </div>
            )}
          </section>
          <section className="card stack">
            {invite.awaiting_me ? (
              <>
                <h2>Your signature</h2>
                <SignatureForm consentText={invite.consent_text} onRespond={respond} />
              </>
            ) : invite.state === "COMPLETED" ? (
              <>
                <h2>All signatures collected</h2>
                <div><button type="button" className="primary" disabled={!!busy} onClick={download}>Download signed PDF</button></div>
                <Link href="/sign/verify">Verify a signed PDF</Link>
              </>
            ) : (
              <>
                <h2>{invite.state === "DECLINED" ? "Signature declined" : "Signature recorded"}</h2>
                {invite.state !== "DECLINED" && <p className="muted">Open this invitation again to download the PDF after the other signers finish.</p>}
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
