"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconSignature, IconSpinner } from "@/components/icons";
import { Checkbox } from "@/components/motion";
import { SignaturePreview, SignatureUpload, type SavedSignature } from "@/components/SignatureImage";
import { TextField } from "@/components/ui";
import { api } from "@/lib/api";
import styles from "./signature-image.module.css";

type Appearance = { type: "image"; image: string } | { type: "saved"; id: string };

export type SignatureDecision =
  | { decision: "sign"; typed_name: string; consent: true; appearance?: Appearance }
  | { decision: "decline"; reason?: string };

export function SignatureForm({ consentText, onRespond, personalSignaturesHref }: {
  consentText: string;
  onRespond: (body: SignatureDecision) => Promise<void>;
  personalSignaturesHref?: string;
}) {
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<SavedSignature[]>([]);
  const [uploaded, setUploaded] = useState("");
  const [selected, setSelected] = useState<SavedSignature | null>(null);
  const [libraryError, setLibraryError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (!personalSignaturesHref) return;
    let active = true;
    function refresh() {
      api<{ signatures: SavedSignature[] }>("me/signatures").then(({ signatures }) => {
        if (!active) return;
        setSaved(signatures);
        setLibraryError("");
      }).catch((err) => { if (active) setLibraryError(err.message); });
    }
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [personalSignaturesHref]);

  async function submit(body: SignatureDecision) {
    setBusy(true);
    try {
      await onRespond(body);
    } finally {
      setBusy(false);
    }
  }

  async function saveImage() {
    setSaving(true);
    setLibraryError("");
    setNotice("");
    try {
      const item = await api<SavedSignature>("me/signatures", {
        method: "POST", body: { label: name.trim().slice(0, 60) || "Signature", image: uploaded },
      });
      setSaved((current) => [item, ...current.filter((signature) => signature.id !== item.id)]);
      setSelected(item);
      setUploaded("");
      setNotice("Signature saved to your account.");
    } catch (err) {
      setLibraryError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const locked = busy || saving || reading;
  const image = selected?.image ?? uploaded;
  const appearance: Appearance | undefined = selected ? { type: "saved", id: selected.id } : uploaded ? { type: "image", image: uploaded } : undefined;

  return declining ? (
    <form className="stack" onSubmit={(event) => { event.preventDefault(); void submit({ decision: "decline", reason: reason.trim() || undefined }); }}>
      <p className="muted">If you decline, the request closes for all signers.</p>
      <TextField label="Reason (optional)" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      <div className="row">
        <button type="submit" className="danger" disabled={busy}>Confirm decline</button>
        <button type="button" className="ghost" disabled={busy} onClick={() => setDeclining(false)}>Back to signing</button>
      </div>
    </form>
  ) : (
    <form className="stack" onSubmit={(event) => {
      event.preventDefault();
      if (!locked && consent && name.trim().length >= 2) void submit({ decision: "sign", typed_name: name.trim(), consent: true, appearance });
    }}>
      <TextField label="Type your full name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} required />
      <SignaturePreview image={image} name={name.trim()} />
      <SignatureUpload onImage={(next) => { setUploaded(next); setSelected(null); setNotice(""); }} onReading={setReading} disabled={locked} replacing={!!image} />
      {image && <div className="row">
        <button type="button" className="quiet small" disabled={locked} onClick={() => { setUploaded(""); setSelected(null); setNotice(""); }}>Use typed signature</button>
        {uploaded && personalSignaturesHref && <button type="button" className="quiet small" disabled={locked || saved.length >= 6} onClick={saveImage}>Save to my signatures</button>}
      </div>}
      {saved.length > 0 && (
        <fieldset className={styles.picker} disabled={locked}>
          <legend>Saved signatures</legend>
          <div className={styles.choices}>
            {saved.map((item) => (
              <button key={item.id} type="button" className="ghost" aria-pressed={selected?.id === item.id} onClick={() => { setSelected(item); setUploaded(""); setNotice(""); }}>
                <img src={`data:image/png;base64,${item.image}`} alt="" />
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {libraryError && <p className="alert" role="alert">{libraryError}</p>}
      {notice && <p className="muted" role="status">{notice}</p>}
      <Checkbox checked={consent} onChange={setConsent} label={consentText} />
      <div className="row">
        <button type="submit" className="primary" disabled={locked || !consent || name.trim().length < 2}>
          {busy ? <IconSpinner size={16} /> : <IconSignature size={16} />} Sign documents
        </button>
        <button type="button" className="ghost" disabled={locked} onClick={() => setDeclining(true)}>Decline</button>
        {personalSignaturesHref && <Link href={personalSignaturesHref} target="_blank" rel="noreferrer" className="btn quiet small">Manage signatures</Link>}
      </div>
    </form>
  );
}
