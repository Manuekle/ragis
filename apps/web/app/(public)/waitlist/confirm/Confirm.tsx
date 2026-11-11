"use client";

import Link from "next/link";
import { useState } from "react";
import { IconAlert, IconArrowRight, IconCheck, IconMail, IconSpinner } from "@/components/icons";
import { SoftText } from "@/components/motion";
import type { PublicBadge } from "@/lib/badge";

type Answer = { error?: { message?: string }; email?: string; badge?: PublicBadge | null; editToken?: string | null };

/**
 * The last step of joining: one button that confirms the email. Pressing it is what uses the
 * link (the page alone does nothing), then the browser keeps the key to the badge and goes to it.
 */
export function Confirm({ token }: { token: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(token ? null : "This link isn't complete. Open it again from the email.");
  // Confirmed, but there is no badge to go to.
  const [joined, setJoined] = useState(false);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist/confirm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token }) });
      const data = (await res.json().catch(() => ({}))) as Answer;
      if (!res.ok) {
        setError(data.error?.message ?? "Couldn't save your place. Try again.");
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
        window.location.replace(`/waitlist/badge/${data.badge.slug}`);
        return;
      }
      setJoined(true);
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    }
    setBusy(false);
  }

  if (joined)
    return (
      <div className="wl-card wl-done" role="status">
        <span className="wl-done-mark">
          <IconCheck size={20} strokeWidth={2.2} />
        </span>
        <h2>You&apos;re on the list.</h2>
        <p>Your email is confirmed. We&apos;ll write to you when your place opens.</p>
      </div>
    );

  return (
    <div className="wl-card wl-done">
      <span className="wl-done-mark" data-kind="mail">
        <IconMail size={20} />
      </span>
      <h1>Confirm your place.</h1>
      <p>One click saves your place on the Ragis waitlist and opens your badge.</p>
      {error && (
        <p className="wl-error" role="alert">
          <IconAlert size={14} />
          <span>{error}</span>
        </p>
      )}
      {token && (
        <button type="button" className="gate-cta halftone" disabled={busy} onClick={confirm}>
          {busy && <IconSpinner size={16} />}
          <SoftText text={busy ? "Confirming…" : "Confirm my email"} />
        </button>
      )}
      {error && (
        <Link href="/waitlist#join" className="wl-back">
          Join the waitlist again
          <IconArrowRight size={14} />
        </Link>
      )}
    </div>
  );
}
