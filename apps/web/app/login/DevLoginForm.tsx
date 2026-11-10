"use client";

import Link from "next/link";
import { useState } from "react";
import { IconAlert, IconSpinner } from "@/components/icons";
import { TextField, useFormErrors } from "@/components/ui";
import { AuthShell, GateChecks } from "./AuthShell";
import { SoftText } from "@/components/motion";

export default function DevLoginForm() {
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
      setError("Couldn't sign in. In production, access is via SSO/OIDC.");
      return;
    }
    window.location.href = "/app";
  }

  return (
    <AuthShell title="Sign in to Ragis." lead="Answers cited to the page." aside={<span className="gate-tag">AUTH_MODE=dev</span>} linkBrandToHome>
      <form className="gate-form" onSubmit={submit} noValidate>
        <p className="gate-note">Dev mode: any email works. Production goes through your company&apos;s SSO.</p>
        <TextField label="Work email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" autoFocus {...form.field("email")} />
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Optional" autoComplete="name" />
        {error && (
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        )}
        <button type="submit" className="gate-cta" disabled={busy}>
          {busy && <IconSpinner size={16} />}
          <SoftText text={busy ? "Signing in…" : "Continue"} />
        </button>
      </form>
      <GateChecks items={["Cited answers", "Permission-aware", "PII redacted"]} />
      <p className="gate-legal">
        By continuing you agree to the <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </AuthShell>
  );
}
