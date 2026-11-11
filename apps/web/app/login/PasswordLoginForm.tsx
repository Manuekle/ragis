"use client";

import Link from "next/link";
import { useState } from "react";
import { IconAlert, IconSpinner } from "@/components/icons";
import { SoftText } from "@/components/motion";
import { TextField, useFormErrors } from "@/components/ui";
import { AuthShell, GateChecks } from "./AuthShell";

type Step = "signin" | "new_password" | "forgot" | "reset";

const COPY: Record<Step, { title: string; lead: string; note?: string; cta: string; busy: string }> = {
  signin: { title: "Sign in to Ragis.", lead: "Use your company account.", cta: "Sign in", busy: "Signing in…" },
  new_password: {
    title: "Choose a new password.",
    lead: "Your account needs one before you continue.",
    note: "Use at least 8 characters, with upper and lower case letters, a number and a symbol.",
    cta: "Save and continue",
    busy: "Saving…",
  },
  forgot: { title: "Reset your password.", lead: "We'll email you a code.", cta: "Send code", busy: "Sending…" },
  reset: { title: "Check your email.", lead: "Enter the code and a new password.", cta: "Reset password", busy: "Resetting…" },
};

/** Inicio de sesión dentro de la app. Cognito solo guarda las cuentas; el navegador nunca sale del sitio. */
export default function PasswordLoginForm() {
  const [step, setStep] = useState<Step>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useFormErrors();
  const copy = COPY[step];

  function go(next: Step, opts?: { notice?: string; error?: string }) {
    setStep(next);
    setPassword("");
    setCode("");
    setError(opts?.error ?? null);
    setNotice(opts?.notice ?? null);
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!form.validate(e.currentTarget)) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    let res: Response;
    try {
      res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ step, email, password: password || undefined, code: code || undefined }),
      });
    } catch {
      setBusy(false);
      setError("Couldn't reach the server. Check your connection.");
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { next?: string; step?: Step; error?: { message?: string } };
    if (!res.ok) {
      setBusy(false);
      if (res.status === 410) return go("signin", { error: data.error?.message });
      setError(data.error?.message ?? "Couldn't complete that. Try again.");
      return;
    }
    if (data.next) {
      window.location.href = data.next; // se mantiene "busy" mientras carga la app
      return;
    }
    setBusy(false);
    if (data.step === "signin") go("signin", { notice: "Password updated. Sign in with it." });
    else if (data.step) go(data.step);
  }

  return (
    <AuthShell title={copy.title} lead={copy.lead} linkBrandToHome>
      <form className="gate-form" onSubmit={submit} noValidate>
        {copy.note && <p className="gate-note">{copy.note}</p>}
        {(step === "signin" || step === "forgot" || step === "reset") && (
          <TextField label="Work email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" autoFocus={step !== "reset"} {...form.field("email")} />
        )}
        {step === "reset" && (
          <TextField label="Code from your email" required value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus {...form.field("code")} />
        )}
        {step !== "forgot" && (
          <TextField
            label={step === "signin" ? "Password" : "New password"}
            type="password"
            required
            minLength={step === "signin" ? undefined : 8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={step === "signin" ? "current-password" : "new-password"}
            autoFocus={step === "new_password"}
            {...form.field("password")}
          />
        )}
        {notice && <p className="gate-note">{notice}</p>}
        {error && (
          <div className="alert">
            <IconAlert size={16} />
            {error}
          </div>
        )}
        <button type="submit" className="gate-cta" disabled={busy}>
          {busy && <IconSpinner size={16} />}
          <SoftText text={busy ? copy.busy : copy.cta} />
        </button>
        {step === "signin" && (
          <button type="button" className="gate-link" onClick={() => go("forgot")} style={{ alignSelf: "flex-start", background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", fontSize: 14 }}>
            Forgot your password?
          </button>
        )}
        {(step === "forgot" || step === "reset") && (
          <button type="button" className="gate-link" onClick={() => go("signin")} style={{ alignSelf: "flex-start", background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", fontSize: 14 }}>
            Back to sign in
          </button>
        )}
      </form>
      <GateChecks items={["Cited answers", "Permission-aware", "PII redacted"]} />
      <p className="gate-legal">
        By continuing you agree to the <Link href="/terms">Terms</Link> and <Link href="/privacy">Privacy Policy</Link>.
      </p>
    </AuthShell>
  );
}
