"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { IconSignature, IconSpinner } from "@/components/icons";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { SignaturePreview, SignatureUpload, type SavedSignature } from "@/components/SignatureImage";
import { TextField, useConfirm } from "@/components/ui";
import { api } from "@/lib/api";
import { SoftText } from "@/components/motion";

export default function PersonalSignaturesPage() {
  const { org } = useParams<{ org: string }>();
  const confirm = useConfirm();
  const [saved, setSaved] = useState<SavedSignature[] | null>(null);
  const [image, setImage] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api<{ signatures: SavedSignature[] }>("me/signatures")
      .then(({ signatures }) => setSaved(signatures)).catch((err) => setError(err.message));
  }, []);

  async function save() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const item = await api<SavedSignature>("me/signatures", { method: "POST", body: { label, image } });
      setSaved((current) => [item, ...(current ?? [])]);
      setImage("");
      setLabel("");
      setNotice("Signature saved.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: SavedSignature) {
    if (!(await confirm({ title: "Remove this saved signature?", body: "Any document you already signed keeps its signature.", confirmLabel: "Remove", tone: "danger" }))) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`me/signatures/${item.id}`, { method: "DELETE" });
      setSaved((current) => current?.filter((signature) => signature.id !== item.id) ?? []);
      setNotice("Signature removed.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const full = (saved?.length ?? 0) >= 6;
  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section="Signatures & sharing" href={`/app/${org}/signatures`} context="My signatures" icon={IconSignature} />
      </header>
      <main className="main stack" style={{ maxWidth: 840 }}>
        <header className="page-head">
          <div><h1>My signatures</h1><p className="sub">Save signature images to use when you sign documents in Ragsis.</p></div>
        </header>
        {error && <p className="alert" role="alert">{error}</p>}
        {notice && <p className="notice" role="status">{notice}</p>}
        <form className="card stack" onSubmit={(event) => {
          event.preventDefault();
          if (image && label.trim() && !busy && !reading && !full && saved) void save();
        }}>
          <h2>Add a signature</h2>
          <SignaturePreview image={image} />
          <SignatureUpload onImage={setImage} onReading={setReading} replacing={!!image} disabled={busy || reading || full || !saved} />
          <TextField label="Signature name" placeholder="e.g. Full signature" maxLength={60} value={label} onChange={(event) => setLabel(event.target.value)} required />
          <div>
            <button type="submit" className="primary" disabled={!saved || !image || !label.trim() || busy || reading || full}>
              {busy ? <IconSpinner size={16} /> : <IconSignature size={16} />} Save signature
            </button>
          </div>
          {full && <p className="muted">You can save up to 6 signatures. Remove one to add another.</p>}
        </form>

        <section className="stack" aria-labelledby="saved-signatures">
          <h2 id="saved-signatures">Saved signatures {saved && <span className="count"><SoftText text={String(saved.length)} /></span>}</h2>
          {!saved && !error && <p role="status">Loading your signatures…</p>}
          {saved?.length === 0 && <p className="muted">Your saved signatures will appear here.</p>}
          {saved?.map((item) => (
            <article className="card stack" key={item.id}>
              <div className="row">
                <h3 style={{ flex: 1 }}>{item.label}</h3>
                <button type="button" className="ghost small" disabled={busy || reading} aria-label={`Remove ${item.label}`} onClick={() => remove(item)}>Remove</button>
              </div>
              <SignaturePreview image={item.image} />
            </article>
          ))}
        </section>
      </main>
    </div>
  );
}
