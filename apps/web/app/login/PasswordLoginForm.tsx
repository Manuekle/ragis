"use client";

import { LocaleLink as Link, useLocale } from "@/components/LocaleProvider";
import { useState } from "react";
import { IconAlert, IconSpinner } from "@/components/icons";
import { SoftText } from "@/components/motion";
import { TextField, useFormErrors } from "@/components/ui";
import { AuthShell, GateChecks } from "./AuthShell";
import { LOGIN } from "./copy";

type Step = "signin" | "new_password" | "forgot" | "reset";

/** Inicio de sesión dentro de la app. Cognito solo guarda las cuentas; el navegador nunca sale del sitio. */
export default function PasswordLoginForm() {
  const t = LOGIN[useLocale()];
  const [step, setStep] = useState<Step>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useFormErrors();
  const copy = t.steps[step]!;

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
      setError(t.noServer);
      return;
    }
    const data = (await res.json().catch(() => ({}))) as { next?: string; step?: Step; error?: { message?: string } };
    if (!res.ok) {
      setBusy(false);
      if (res.status === 410) return go("signin", { error: data.error?.message });
      setError(data.error?.message ?? t.noComplete);
      return;
    }
    if (data.next) {
      window.location.href = data.next; // se mantiene "busy" mientras carga la app
      return;
    }
    setBusy(false);
    if (data.step === "signin") go("signin", { notice: t.updated });
    else if (data.step) go(data.step);
  }

  return (
    <AuthShell title={copy.title} lead={copy.lead} home={t.home} linkBrandToHome>
      <form className="gate-form" onSubmit={submit} noValidate>
        {copy.note && <p className="gate-note">{copy.note}</p>}
        {(step === "signin" || step === "forgot" || step === "reset") && (
          <TextField label={t.email} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" autoComplete="email" autoFocus={step !== "reset"} {...form.field("email")} />
        )}
        {step === "reset" && (
          <TextField label={t.code} required value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus {...form.field("code")} />
        )}
        {step !== "forgot" && (
          <TextField
            label={step === "signin" ? t.password : t.newPassword}
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
            {t.forgot}
          </button>
        )}
        {(step === "forgot" || step === "reset") && (
          <button type="button" className="gate-link" onClick={() => go("signin")} style={{ alignSelf: "flex-start", background: "none", border: 0, padding: 0, cursor: "pointer", font: "inherit", fontSize: 14 }}>
            {t.back}
          </button>
        )}
      </form>
      <GateChecks items={t.checks} />
      <p className="gate-legal">
        {t.legalA}<Link href="/terms">{t.terms}</Link>{t.legalB}<Link href="/privacy">{t.privacy}</Link>.
      </p>
    </AuthShell>
  );
}
