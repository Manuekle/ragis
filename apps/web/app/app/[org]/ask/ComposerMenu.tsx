"use client";

import { useCallback, useLayoutEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { IconCheck } from "@/components/icons";
import { useDropdown } from "@/components/motion";

/**
 * Menus of the Ask composer ("Answer as", "Public records"): a panel as wide as the composer, one line per option
 * (icon tile, title, hint), a footer note, arrow-key navigation. It opens towards the side of the composer with more
 * room inside the chat column (which clips), so it never hides behind the page header.
 */
export function useComposerMenu() {
  const menu = useDropdown();
  const [place, setPlace] = useState<{ dir: "up" | "down"; max: number }>({ dir: "up", max: 360 });

  useLayoutEffect(() => {
    if (!menu.isOpen) return;
    const host = menu.ref.current;
    const composer = host?.closest(".composer");
    const column = host?.closest(".chat") ?? document.body;
    if (!composer) return;
    const c = composer.getBoundingClientRect();
    const b = column.getBoundingClientRect();
    // The page bar (title, History) sits at the top of the column: room above starts below it.
    const top = column.querySelector(".chat-scroll")?.getBoundingClientRect().top ?? b.top;
    const above = c.top - Math.max(top, 0) - 12;
    const below = Math.min(b.bottom, window.innerHeight) - c.bottom - 12;
    const dir = below > above ? "down" : "up";
    setPlace({ dir, max: Math.round(Math.max(180, Math.min(460, dir === "down" ? below : above))) });
  }, [menu.isOpen, menu.ref]);

  /** Arrow keys on the trigger open the menu and land on the chosen option. */
  const onTriggerKey = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      if (!menu.isOpen) menu.toggle();
      requestAnimationFrame(() => {
        const root = menu.ref.current;
        const target = root?.querySelector<HTMLElement>('.cmenu-item[aria-checked="true"]') ?? root?.querySelector<HTMLElement>(".cmenu-item");
        target?.focus();
      });
    },
    [menu],
  );

  return { menu, place, onTriggerKey };
}

function moveFocus(e: KeyboardEvent<HTMLDivElement>) {
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(".cmenu-item"));
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[e.key];
  if (next === undefined || !items.length) return;
  e.preventDefault();
  items[(next + items.length) % items.length]?.focus();
}

export function ComposerMenu({ state, label, footer, children }: { state: ReturnType<typeof useComposerMenu>; label: string; footer?: ReactNode; children: ReactNode }) {
  const { menu, place } = state;
  return (
    <div
      className={`menu cmenu ${menu.cls}`}
      role="menu"
      aria-label={label}
      data-dir={place.dir}
      data-origin={place.dir === "up" ? "bottom-left" : undefined}
      style={{ "--cmenu-max": `${place.max}px` } as CSSProperties}
      inert={!menu.isOpen}
      onKeyDown={moveFocus}
    >
      <div className="cmenu-list">{children}</div>
      {footer && <div className="cmenu-foot">{footer}</div>}
    </div>
  );
}

export function CommandGroup({ label, grid, children }: { label?: string; grid?: boolean; children: ReactNode }) {
  return (
    <div className="cmenu-group" role="group" aria-label={label}>
      {label && <div className="cmenu-label">{label}</div>}
      <div className={grid ? "cmenu-grid" : "cmenu-rows"}>{children}</div>
    </div>
  );
}

export function CommandItem({ icon, title, hint, checked, onClick, bare }: { icon: ReactNode; title: string; hint?: string; checked: boolean; onClick: () => void; bare?: boolean }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} className="cmenu-item" onClick={onClick} title={hint ? `${title} — ${hint}` : undefined}>
      <span className={`cmenu-ico${bare ? " is-bare" : ""}`} aria-hidden="true">
        {icon}
      </span>
      <span className="cmenu-text">
        <span className="cmenu-title">{title}</span>
        {hint && <span className="cmenu-hint">{hint}</span>}
      </span>
      {checked && <IconCheck className="cmenu-check" size={16} />}
    </button>
  );
}
