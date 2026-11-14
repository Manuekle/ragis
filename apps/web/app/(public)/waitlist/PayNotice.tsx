"use client";

import { useEffect, useState } from "react";
import { IconAlert, IconArrowRight, IconSparkles, IconSpinner } from "@/components/icons";
import { SoftText } from "@/components/motion";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });

// The same key the badge itself uses to remember its owner in this browser (components/badge/BadgeShowcase.tsx).
const tokenKey = (slug: string) => `ragis:badge:${slug}`;

type Due = { tier: string; name: string; price: number };

/**
 * What is left to do for a sponsor slot: pay for it. Shown to the badge's owner only (the edit
 * token in this browser is what the server checks) and only while a sponsor slot is waiting for
 * its payment, so it renders nothing for early access, for a paid slot, or when Polar is off.
 *
 * Coming back from Polar (`?paid=1`) the slot is confirmed by Polar's webhook a moment later: the
 * notice checks every few seconds and then reloads the page so the badge wears its tier.
 */
export function PayNotice({ slug, editToken }: { slug: string; editToken?: string | null }) {
  const [due, setDue] = useState<Due | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [returned, setReturned] = useState(false);
  const [late, setLate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let own = editToken ?? null;
    if (!own) {
      try {
        own = localStorage.getItem(tokenKey(slug));
      } catch {}
    }
    if (!own) return;
    setToken(own);
    const back = new URLSearchParams(window.location.search).has("paid");
    setReturned(back);

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const key = own;

    async function check() {
      try {
        const res = await fetch(`/api/waitlist/pay?slug=${encodeURIComponent(slug)}`, { headers: { "x-badge-token": key } });
        const data = (await res.json().catch(() => ({}))) as { due?: Due | null };
        if (!alive) return;
        setDue(data.due ?? null);
        if (!back) return;
        if (!data.due) {
          // Paid and confirmed: reload without ?paid so the badge shows its tier.
          window.location.replace(window.location.pathname);
        } else if (++tries < 10) timer = setTimeout(check, 3000);
        else setLate(true);
      } catch {}
    }
    check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [slug, editToken]);

  async function pay() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist/pay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, editToken: token }) });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: { message?: string } };
      if (res.ok && data.url) {
        window.location.assign(data.url);
        return; // leaving the page: keep the button busy
      }
      setError(data.error?.message ?? "Couldn't open the payment page. Try again.");
    } catch {
      setError("Couldn't reach the server. Check your connection.");
    }
    setBusy(false);
  }

  if (!due) return null;

  if (returned)
    return (
      <div className="wl-pay" role="status">
        <p>
          {late
            ? `Your payment is taking longer than usual to show up. Refresh in a minute. If your ${due.name} slot isn't confirmed by then, reply to the receipt email.`
            : `Payment received. Confirming your ${due.name} slot…`}
        </p>
        {!late && <IconSpinner size={16} />}
      </div>
    );

  return (
    <div className="wl-pay">
      <p>
        Your {due.name} slot is waiting for its payment. It is yours once the payment goes through, first paid, first served.
      </p>
      {error && (
        <p className="wl-error" role="alert">
          <IconAlert size={14} />
          <span>{error}</span>
        </p>
      )}
      <button type="button" className="gate-cta halftone" disabled={busy} onClick={pay}>
        {busy ? <IconSpinner size={16} /> : <IconSparkles size={16} variant="duotone" />}
        <SoftText text={busy ? "Opening checkout…" : `Pay ${usd.format(due.price)} with Polar`} />
        {!busy && <IconArrowRight size={16} />}
      </button>
      <p className="wl-fine">Paid once, in USD. Polar processes the payment and collects any sales tax.</p>
    </div>
  );
}
