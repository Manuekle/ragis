"use client";

import { LocaleLink as Link, useLocale, useLocalePath } from "@/components/LocaleProvider";
import { useState } from "react";
import { IconAlert, IconArrowRight, IconCheck, IconMail, IconSpinner } from "@/components/icons";
import { SoftText } from "@/components/motion";
import type { PublicBadge } from "@/lib/badge";

const TEXT = {
  en: {
    incomplete: "This link isn't complete. Open it again from the email.",
    noSave: "Couldn't save your place. Try again.",
    noServer: "Couldn't reach the server. Check your connection.",
    onList: "You're on the list.",
    confirmed: "Your email is confirmed. We'll write to you when your place opens.",
    title: "Confirm your place.",
    lead: "One click saves your place on the Ragis waitlist and opens your badge.",
    confirming: "Confirming…",
    confirm: "Confirm my email",
    again: "Join the waitlist again",
  },
  es: {
    incomplete: "Este enlace está incompleto. Ábrelo de nuevo desde el correo.",
    noSave: "No se pudo guardar tu lugar. Inténtalo de nuevo.",
    noServer: "No se pudo conectar con el servidor. Comprueba tu conexión.",
    onList: "Ya estás en la lista.",
    confirmed: "Tu correo está confirmado. Te escribiremos cuando se abra tu lugar.",
    title: "Confirma tu lugar.",
    lead: "Un clic guarda tu lugar en la lista de espera de Ragis y abre tu insignia.",
    confirming: "Confirmando…",
    confirm: "Confirmar mi correo",
    again: "Volver a unirme a la lista de espera",
  },
};

type Answer = { error?: { message?: string }; email?: string; badge?: PublicBadge | null; editToken?: string | null };

/**
 * The last step of joining: one button that confirms the email. Pressing it is what uses the
 * link (the page alone does nothing), then the browser keeps the key to the badge and goes to it.
 */
export function Confirm({ token }: { token: string }) {
  const locale = useLocale();
  const t = TEXT[locale];
  const localePath = useLocalePath();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : t.incomplete);
  // Confirmed, but there is no badge to go to.
  const [joined, setJoined] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, locale }) });
      const data = (await res.json().catch(() => ({}))) as Answer;
      if (!res.ok) {
        setError(data.error?.message ?? t.noSave);
        setBusy(false);
        return;
      }
      if (data.badge && data.editToken) {
        try {
          // The same keys the sign-up form and the badge page use.
          localStorage.setItem(`ragis:badge:${data.badge.slug}`, data.editToken);
          if (data.email) localStorage.setItem(`ragis:waitlist:${data.email}`, data.badge.slug);
        } catch {}
        // replace: going back must not land on a link that no longer works.
        window.location.replace(localePath(`/waitlist/badge/${data.badge.slug}`));
        return;
      }
      setJoined(true);
    } catch {
      setError(t.noServer);
    }
    setBusy(false);
  }

  if (joined)
    return (
      <div className="wl-card wl-done" role="status">
        <span className="wl-done-mark">
          <IconCheck size={20} strokeWidth={2.2} />
        </span>
        <h2>{t.onList}</h2>
        <p>{t.confirmed}</p>
      </div>
    );

  return (
    <div className="wl-card wl-done">
      <span className="wl-done-mark" data-kind="mail">
        <IconMail size={20} />
      </span>
      <h1>{t.title}</h1>
      <p>{t.lead}</p>
      {error && (
        <p className="wl-error" role="alert">
          <IconAlert size={14} />
          <span>{error}</span>
        </p>
      )}
      {token && (
        <button type="button" className="gate-cta halftone" disabled={busy} onClick={confirm}>
          {busy && <IconSpinner size={16} />}
          <SoftText text={busy ? t.confirming : t.confirm} />
        </button>
      )}
      {error && (
        <Link href="/waitlist" className="wl-back">
          {t.again}
          <IconArrowRight size={14} />
        </Link>
      )}
    </div>
  );
}
