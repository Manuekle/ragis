"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { IconSignature, IconSpinner } from "@/components/icons";
import { PageBreadcrumbs } from "@/components/PageBreadcrumbs";
import { TextField } from "@/components/ui";
import { api } from "@/lib/api";
import { SoftText } from "@/components/motion";
import { useT } from "@/lib/use-t";

interface DocumentOption {
  version_id: string;
  title: string;
  filename: string;
}

export default function NewEnvelopePage() {
  const t = useT();
  const { org } = useParams<{ org: string }>();
  const router = useRouter();
  const key = useRef<string | null>(null);
  const nextSignerId = useRef(1);
  const [docs, setDocs] = useState<DocumentOption[] | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [subject, setSubject] = useState("");
  const [query, setQuery] = useState("");
  const [signers, setSigners] = useState([{ id: 0, name: "", email: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<{ documents: DocumentOption[] }>(`organizations/${org}/signatures/eligible-documents`)
      .then(({ documents }) => setDocs(documents)).catch((err) => setError(err.message));
  }, [org]);

  async function save() {
    setBusy(true);
    setError("");
    key.current ??= crypto.randomUUID();
    try {
      const { id } = await api<{ id: string }>(`organizations/${org}/signatures`, {
        method: "POST",
        headers: { "idempotency-key": key.current },
        body: { subject, version_ids: selected, signers: signers.map(({ name, email }) => ({ name, email })) },
      });
      router.push(`/app/${org}/signatures/${id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  const visibleDocs = docs?.filter((d) => `${d.title} ${d.filename}`.toLowerCase().includes(query.trim().toLowerCase()));
  const valid = subject.trim().length >= 2 && selected.length > 0 && signers.every((s) => s.name.trim().length >= 2 && s.email.trim());

  return (
    <div className="page">
      <header className="page-bar">
        <PageBreadcrumbs section={t("Signatures & sharing")} href={`/app/${org}/signatures`} context={t("Request signatures")} icon={IconSignature} />
      </header>
      <div className="main" style={{ maxWidth: 900 }}>
        <header className="page-head">
          <div><h1>{t("Request signatures")}</h1><p className="sub">{t("Choose PDFs from your library and add the people who need to sign.")}</p></div>
        </header>
        {error && <p role="alert" className="alert" style={{ marginTop: 16 }}>{error}</p>}
        <form className="stack" style={{ marginTop: 20 }} onSubmit={(event) => { event.preventDefault(); if (valid) void save(); }}>
          <fieldset className="stack" disabled={busy} style={{ padding: 0, border: 0, margin: 0, minWidth: 0 }}>
            <section className="card stack">
              <h2>{t("Request details")}</h2>
              <TextField label={t("Subject")} placeholder={t("e.g. Services agreement")} value={subject} required minLength={2} maxLength={160} onChange={(e) => { key.current = null; setSubject(e.target.value); }} />
            </section>
            <section className="card stack">
              <h2>{t("Documents")}{" "}<span className="count"><SoftText text={String(selected.length)} /></span></h2>
              <TextField label={t("Find a PDF")} type="search" value={query} onChange={(e) => setQuery(e.target.value)} />
              {!docs && !error && <p role="status">{t("Loading PDFs…")}</p>}
              {visibleDocs?.length === 0 && <p className="muted">{query ? t("No PDFs match this search.") : t("Upload a PDF to the Library and wait for indexing.")}</p>}
              <div className="stack" style={{ gap: 8, maxHeight: 280, overflowY: "auto" }}>
                {visibleDocs?.map((doc) => (
                  <label className="row" key={doc.version_id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(doc.version_id)}
                      disabled={selected.length >= 10 && !selected.includes(doc.version_id)}
                      onChange={(e) => {
                        key.current = null;
                        setSelected(e.target.checked ? [...selected, doc.version_id] : selected.filter((id) => id !== doc.version_id));
                      }}
                    />
                    <span>{doc.title} <small className="muted">{doc.filename}</small></span>
                  </label>
                ))}
              </div>
            </section>
            <section className="card stack">
              <h2>{t("Signers")}</h2>
              {signers.map((signer, index) => (
                <div className="row" key={signer.id} style={{ alignItems: "end" }}>
                  <TextField label={t("Signer {v1} name", { v1: index + 1 })} value={signer.name} maxLength={120} required minLength={2} onChange={(e) => {
                    key.current = null;
                    setSigners(signers.map((s) => s.id === signer.id ? { ...s, name: e.target.value } : s));
                  }} />
                  <TextField label={t("Signer {v1} email", { v1: index + 1 })} type="email" value={signer.email} required onChange={(e) => {
                    key.current = null;
                    setSigners(signers.map((s) => s.id === signer.id ? { ...s, email: e.target.value } : s));
                  }} />
                  {signers.length > 1 && <button className="ghost small" type="button" aria-label={t("Remove signer {v1}", { v1: index + 1 })} onClick={() => {
                    key.current = null;
                    setSigners(signers.filter((s) => s.id !== signer.id));
                  }}>{t("Remove")}</button>}
                </div>
              ))}
              <div><button type="button" className="ghost" disabled={signers.length >= 10} onClick={() => {
                key.current = null;
                setSigners([...signers, { id: nextSignerId.current++, name: "", email: "" }]);
              }}>{t("Add signer")}</button></div>
            </section>
            <div className="row">
              <button type="submit" className="primary" disabled={!valid || busy}>
                {busy ? <IconSpinner size={16} /> : <IconSignature size={16} />}{" "}{t("Save draft")}</button>
              <p className="muted">{t("Another signatory or an administrator will approve and send it.")}</p>
            </div>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
