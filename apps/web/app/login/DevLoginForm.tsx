"use client";

import { LocaleLink as Link, useLocale } from "@/components/LocaleProvider";
import { useState } from "react";
import { IconAlert, IconSpinner } from "@/components/icons";
import { TextField, useFormErrors } from "@/components/ui";
import { AuthShell, GateChecks } from "./AuthShell";
import { SoftText } from "@/components/motion";
import { LOGIN } from "./copy";

export default function DevLoginForm() {
  const t = LOGIN[useLocale()];
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useFormErrors();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.validate(e.currentTarget)) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, name: name || undefined }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(t.devFail);
      return;
    }
    window.location.href = "/app";
  }

  return (
    <AuthShell title={t.ssoTitle} lead={t.devLead} home={t.home} aside={<span className="gate-tag">AUTH_MODE=dev</span>} linkBrandToHome>
      <form className="gate-form" onSubmit={submit} noValidate>
        <p className="gate-note">{t.devNote}</p>
        <TextField label={t.email} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" autoFocus {...form.field("email")} />
        <TextField label={t.name} value={name} onChange={(e) => setName(e.target.value)} placeholder={t.optional} autoComplete="name" />
        {error && (
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        )}
        <button type="submit" className="gate-cta" disabled={busy}>
          {busy && <IconSpinner size={16} />}
          <SoftText text={busy ? t.signingIn : t.cont} />
        </button>
      </form>
      <GateChecks items={t.checks} />
      <p className="gate-legal">
        {t.legalA}<Link href="/terms">{t.terms}</Link>{t.legalB}<Link href="/privacy">{t.privacy}</Link>.
      </p>
    </AuthShell>
  );
}
