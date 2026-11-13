"use client";

import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconSpinner, IconX, type IconProps } from "./icons";

/**
 * Form in a dialog, on the same surface as the confirm dialog. Esc, the close button or a click outside cancel.
 * Focus moves into the dialog on open, stays inside while it is open and returns where it was on close.
 */
export function FormDialog({
  title,
  description,
  icon: Icon,
  submitLabel,
  busy = false,
  disabled = false,
  wide = false,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  description?: ReactNode;
  icon: ComponentType<IconProps>;
  submitLabel: string;
  busy?: boolean;
  disabled?: boolean;
  wide?: boolean;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [shown, setShown] = useState(false);
  const boxRef = useRef<HTMLFormElement>(null);
  const id = useId();

  useEffect(() => {
    const restore = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => {
      setShown(true);
      const box = boxRef.current;
      (box?.querySelector<HTMLElement>("[data-autofocus]") ?? box?.querySelector<HTMLElement>("input, textarea, button.select-trigger"))?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      // A select or date picker marks the Escape it consumes with preventDefault; the dialog must not also close.
      if (e.key === "Escape" && !e.defaultPrevented && !document.querySelector(".menu.floating.is-open")) onClose();
      if (e.key === "Tab" && boxRef.current) {
        const f = Array.from(boxRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [href]")).filter((el) => el.offsetParent !== null);
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && i <= 0) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && (i === f.length - 1 || i === -1)) {
          // i === -1: the focused control got disabled while submitting (the submit button) and focus fell to body.
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
      restore?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div className={`dialog-layer${shown ? " is-open" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        ref={boxRef}
        className={`dialog${wide ? " wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-t`}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && !disabled) onSubmit();
        }}
      >
        <button type="button" className="dialog-close" aria-label="Close" onClick={onClose}>
          <IconX size={16} />
        </button>
        <span className="dialog-icon">
          <Icon size={20} variant="duotone" />
        </span>
        <h2 id={`${id}-t`}>{title}</h2>
        {description && <p className="dialog-desc">{description}</p>}
        {children}
        <div className="dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy || disabled} aria-busy={busy}>
            {busy && <IconSpinner size={15} />}
            {submitLabel}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
