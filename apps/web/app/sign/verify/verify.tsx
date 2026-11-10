"use client";

import { useState, type FormEvent } from "react";
import { IconSignature } from "@/components/icons";
import { TextField } from "@/components/ui";
import { fileSha256 } from "@/lib/signature-proof";
import { SoftText } from "@/components/motion";

export function VerifySignature() {
  const [id, setId] = useState("");
  const [pdf, setPdf] = useState<File | null>(null);
  const [certificate, setCertificate] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pdf) return;
    setBusy(true);
    setResult(null);
    try {
      const response = await fetch(`/api/signature-proof/${encodeURIComponent(id.trim().toLowerCase())}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 404 ? "No completed signature request matches this ID." : "Verification is temporarily unavailable.");
      const expected = await response.json() as { signed_sha256: string; certificate_sha256: string };
      const [pdfHash, certificateHash] = await Promise.all([fileSha256(pdf), certificate && fileSha256(certificate)]);
      const ok = pdfHash === expected.signed_sha256 && (!certificateHash || certificateHash === expected.certificate_sha256);
      setResult({ ok, message: ok ? (certificate ? "The PDF and certificate match the Ragsis signing record." : "The PDF matches the Ragsis signing record.") : "The selected files differ from the Ragsis signing record." });
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="stack" style={{ maxWidth: 680, margin: "0 auto", padding: "clamp(20px, 5vw, 56px)" }}>
      <span className="row muted"><IconSignature size={18} /> Ragsis Sign</span>
      <h1>Verify a signed PDF</h1>
      <p className="muted">Use the request ID shown on the signature page. Your files never leave your browser.</p>
      <form className="card stack" onSubmit={verify}>
        <TextField label="Request ID" required value={id} onChange={(event) => { setId(event.target.value); setResult(null); }} />
        <div className="stack" style={{ gap: 6 }}>
          <label htmlFor="verify-pdf">Signed PDF</label>
          <input id="verify-pdf" type="file" required accept="application/pdf,.pdf" onChange={(event) => { setPdf(event.target.files?.[0] ?? null); setResult(null); }} />
        </div>
        <div className="stack" style={{ gap: 6 }}>
          <label htmlFor="verify-certificate">Certificate (optional)</label>
          <input id="verify-certificate" type="file" accept="application/json,.json" onChange={(event) => { setCertificate(event.target.files?.[0] ?? null); setResult(null); }} />
        </div>
        <div><button type="submit" className="primary" disabled={busy || !id.trim() || !pdf}><SoftText text={busy ? "Checking…" : "Verify files"} /></button></div>
      </form>
      {result && <p className={result.ok ? "notice" : "alert"} role="status">{result.message}</p>}
    </main>
  );
}
