"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Reads a CSS duration token ("350ms" / "0.35s") from :root so JS waits exactly as long as the CSS transition. */
function cssDuration(name: string, fallback: number) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const n = parseFloat(raw);
  if (!Number.isFinite(n)) return fallback;
  return raw.endsWith("ms") ? n : raw.endsWith("s") ? n * 1000 : n;
}

/**
 * Floating side panel over the current page (the page stays behind it, so nothing is lost when it closes).
 * Opens and closes with the "panel reveal" transition in teams.css (`data-open` drives it); `onClose` runs once the
 * close transition has finished, so the parent can unmount it. Esc, the scrim or `close()` from a child close it.
 * Focus moves in on open, stays inside and returns where it was. A dialog or menu opened above it owns the keyboard.
 */
export function Sheet({ label, onClose, children }: { label: string; onClose: () => void; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const closing = useRef(false);
  const timer = useRef<number | undefined>(undefined);

  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setOpen(false);
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const ms = reduced ? cssDuration("--duration-quick", 150) : cssDuration("--panel-close-dur", 350);
    timer.current = window.setTimeout(() => closeRef.current(), ms);
  }, []);

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    // Reflow with data-open="false" committed, then open: the transition always runs, even in a background tab
    // where requestAnimationFrame is paused.
    void boxRef.current?.offsetWidth;
    setOpen(true);
    boxRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      // A select or date picker consumes its own Escape (and stops it), so the panel behind it stays open.
      if (e.defaultPrevented || document.querySelector(".dialog-layer.is-open, .menu.floating.is-open")) return;
      if (e.key === "Escape") close();
      if (e.key === "Tab" && boxRef.current) {
        const f = Array.from(boxRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href]")).filter(
          (el) => el.offsetParent !== null,
        );
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && (i === f.length - 1 || i === -1)) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      window.clearTimeout(timer.current);
      document.removeEventListener("keydown", onKey);
      restore?.focus?.({ preventScroll: true });
    };
  }, [close]);

  return createPortal(
    <div className="sheet-layer" data-open={open} onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <aside ref={boxRef} className="sheet" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
        {children(close)}
      </aside>
    </div>,
    document.body,
  );
}
