"use client";

// Custom form primitives. Nothing here renders a native control's UI: selects are listboxes,
// the date picker is a calendar popover, confirms are an in-app dialog and validation messages
// replace the browser's bubbles.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { Blobatar } from "@blobatar/react";
import { createPortal } from "react-dom";
import { IconAlert, IconCalendar, IconCheck, IconChevronDown, IconChevronLeft, IconChevronRight, IconX, type IconProps } from "./icons";

const CLOSE_MS = 150;

/** FNV-1a hash of a name/title: one number drives both the bg gradient and the blob colour. */
function avatarHash(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Hue (deg) shared by the bg gradient and the blobatar so the two always match. */
export function avatarHue(seed: string) {
  return avatarHash(seed) % 360;
}

function hslRgb(h: number, s: number, l: number): [number, number, number] {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return (lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255;
  };
  return [f(0), f(8), f(4)];
}

function luminance([r, g, b]: [number, number, number]) {
  const c = [r, g, b].map((v) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

function contrast(a: [number, number, number], b: [number, number, number]) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Blobatar head colour for a given bg hue: same hue, saturated, as light as it can be while keeping
 * ≥3:1 against every gradient stop (WCAG non-text) and ≥4.5:1 against the white eyes. Yellows/greens/cyans
 * come out darker than reds/blues because they are perceptually brighter at equal lightness.
 */
export function avatarHead(hue: number) {
  const stops = [hslRgb(hue, 80, 90), hslRgb((hue + 22) % 360, 85, 79), hslRgb((hue + 54) % 360, 88, 72)];
  const white: [number, number, number] = [255, 255, 255];
  let l = 44;
  for (; l > 12; l--) {
    const head = hslRgb(hue, 72, l);
    if (contrast(white, head) >= 4.5 && Math.min(...stops.map((s) => contrast(head, s))) >= 3) break;
  }
  return `#${hslRgb(hue, 72, l).map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/** Deterministic gradient seed from a name/title (same name → same avatar bg). */
export function avatarStyle(seed: string) {
  const n = avatarHash(seed);
  const hue = n % 360;
  return {
    ["--av-base" as string]: `hsl(${hue} 80% 90%)`,
    ["--av-mid" as string]: `hsl(${(hue + 22) % 360} 85% 79%)`,
    ["--av-hot" as string]: `hsl(${(hue + 54) % 360} 88% 72%)`,
    ["--av-x" as string]: `${54 + ((n >>> 8) % 22)}%`,
    ["--av-y" as string]: `${54 + ((n >>> 16) % 22)}%`,
  };
}

/**
 * Avatar gradient vars plus `--av-ink`: the avatarHead colour (same hue, contrast-checked against every
 * stop), used for an icon drawn on the gradient. Set on a card so its `.grain-tile` and hover tint share one hue.
 */
export function grainVars(seed: string) {
  const s = seed.trim() || "·";
  return { ...avatarStyle(s), ["--av-ink" as string]: avatarHead(avatarHue(s)) };
}

/** Deterministic avatar: same name → same grainy gradient bg + same blobatar on top. */
export function Avatar({
  name,
  size = "md",
  className,
  animate,
}: {
  name: string;
  size?: "md" | "sm";
  className?: string;
  /** Blobatar idle motion; needs `blobatar/motion.css` loaded by the caller. */
  animate?: "hover" | "always";
}) {
  const seed = name.trim() || "·";
  return (
    <span
      className={`avatar${size === "sm" ? " sm" : ""}${className ? ` ${className}` : ""}`}
      style={avatarStyle(seed)}
      aria-hidden="true"
    >
      {/* head = bg hue, darkened until it contrasts (see avatarHead); white eyes */}
      <Blobatar
        name={seed}
        size={size === "sm" ? 28 : 34}
        hue={avatarHue(seed)}
        palette={{ head: avatarHead(avatarHue(seed)), eye: "#ffffff" }}
        animate={animate}
      />
    </span>
  );
}

/* ───────────── floating popover (portal + fixed positioning, escapes overflow containers) ───────────── */

type Placement = "bottom" | "top";

function usePopover({ align = "start", gap = 6 }: { align?: "start" | "end"; gap?: number } = {}) {
  const [state, setState] = useState<"closed" | "open" | "closing">("closed");
  const [pos, setPos] = useState<{ top: number; left: number; minWidth: number; placement: Placement } | null>(null);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const place = useCallback(() => {
    const a = anchorRef.current;
    const f = floatRef.current;
    if (!a || !f) return;
    const r = a.getBoundingClientRect();
    const h = f.offsetHeight;
    const w = Math.max(f.offsetWidth, r.width);
    const below = window.innerHeight - r.bottom - gap - 8;
    const placement: Placement = below < h && r.top - gap - 8 > below ? "top" : "bottom";
    const top = placement === "bottom" ? r.bottom + gap : r.top - gap - h;
    let left = align === "end" ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    setPos({ top, left, minWidth: r.width, placement });
  }, [align, gap]);

  const close = useCallback((refocus = false) => {
    setState((s) => (s === "open" ? "closing" : s));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState((s) => (s === "closing" ? "closed" : s)), CLOSE_MS);
    if (refocus) anchorRef.current?.focus();
  }, []);
  const open = useCallback(() => {
    clearTimeout(timer.current);
    setState("open");
  }, []);

  useLayoutEffect(() => {
    if (state === "open") place();
  }, [state, place]);

  useEffect(() => {
    if (state !== "open") return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchorRef.current?.contains(t) && !floatRef.current?.contains(t)) close();
    };
    const onMove = () => place();
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("resize", onMove);
    window.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("resize", onMove);
      window.removeEventListener("scroll", onMove, true);
    };
  }, [state, close, place]);

  useEffect(() => () => clearTimeout(timer.current), []);

  // Escape belongs to the popover that has the focus. Capture phase, so the Sheet or dialog behind it never sees
  // the event: they close on Escape too, and a bubble-phase listener would close the whole layer along with the menu.
  useEffect(() => {
    if (state !== "open") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const active = document.activeElement;
      if (!anchorRef.current?.contains(active) && !floatRef.current?.contains(active)) return;
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [state, close]);

  const cls = `t-dropdown${state === "open" ? " is-open" : state === "closing" ? " is-closing" : ""}`;
  const origin = `${pos?.placement === "top" ? "bottom" : "top"}-${align === "end" ? "right" : "left"}`;
  const style = pos ? { top: pos.top, left: pos.left, minWidth: pos.minWidth } : { top: -9999, left: -9999 };
  const render = (node: ReactNode) => (mounted && state !== "closed" ? createPortal(node, document.body) : null);
  return { anchorRef, floatRef, isOpen: state === "open", open, close, toggle: () => (state === "open" ? close() : open()), cls, origin, style, render };
}

/* ───────────── Select (listbox) ───────────── */

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export function Select({
  value,
  onChange,
  options,
  placeholder = "Select…",
  ariaLabel,
  size = "md",
  className,
  id,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Option[];
  placeholder?: string;
  ariaLabel: string;
  size?: "md" | "sm";
  className?: string;
  /** Lets a visible <label htmlFor> name the trigger as well. */
  id?: string;
}) {
  const pop = usePopover();
  const autoId = useId();
  const listId = `${autoId}-list`;
  const [active, setActive] = useState(-1);
  const typed = useRef({ text: "", at: 0 });
  const listRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  const openAt = (i: number) => {
    setActive(i);
    pop.open();
  };
  const pick = (i: number) => {
    const o = options[i];
    if (o) onChange(o.value);
    pop.close(true);
  };

  useEffect(() => {
    if (!pop.isOpen || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, pop.isOpen]);

  function onKeyDown(e: React.KeyboardEvent) {
    const cur = options.findIndex((o) => o.value === value);
    if (!pop.isOpen) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        openAt(cur >= 0 ? cur : e.key === "ArrowUp" ? options.length - 1 : 0);
      }
      return;
    }
    const last = options.length - 1;
    if (e.key === "ArrowDown") setActive((i) => Math.min(last, i + 1));
    else if (e.key === "ArrowUp") setActive((i) => Math.max(0, i - 1));
    else if (e.key === "Home") setActive(0);
    else if (e.key === "End") setActive(last);
    else if (e.key === "Enter" || e.key === " ") pick(active);
    else if (e.key === "Tab") return pop.close();
    else if (e.key.length === 1) {
      const now = Date.now();
      typed.current.text = (now - typed.current.at > 600 ? "" : typed.current.text) + e.key.toLowerCase();
      typed.current.at = now;
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(typed.current.text));
      if (hit >= 0) setActive(hit);
    } else return;
    e.preventDefault();
  }

  return (
    <>
      <button
        ref={pop.anchorRef}
        id={id}
        type="button"
        role="combobox"
        // Include the current value in the name: aria-label replaces the button's text content for AT, so without
        // this the control announced only its label and never what is selected.
        aria-label={`${ariaLabel}: ${selected?.label ?? placeholder}`}
        aria-haspopup="listbox"
        aria-expanded={pop.isOpen}
        aria-controls={listId}
        aria-activedescendant={pop.isOpen && active >= 0 ? `${autoId}-${active}` : undefined}
        className={`select-trigger ${size}${selected ? "" : " is-placeholder"}${className ? ` ${className}` : ""}`}
        onClick={() => (pop.isOpen ? pop.close() : openAt(Math.max(0, options.findIndex((o) => o.value === value))))}
        onKeyDown={onKeyDown}
      >
        <span className="select-value">{selected?.label ?? placeholder}</span>
        <IconChevronDown size={15} className="chev" />
      </button>
      {pop.render(
        <div
          ref={(el) => {
            pop.floatRef.current = el;
            listRef.current = el;
          }}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`menu floating ${pop.cls}`}
          data-origin={pop.origin}
          style={pop.style}
          inert={!pop.isOpen}
        >
          {options.length === 0 && <div className="menu-empty" role="presentation">No options</div>}
          {options.map((o, i) => (
            <div
              key={o.value}
              id={`${autoId}-${i}`}
              data-i={i}
              role="option"
              aria-selected={o.value === value}
              className={`menu-item${i === active ? " is-active" : ""}`}
              onPointerMove={() => setActive(i)}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="menu-text">
                <span className="menu-opt">{o.label}</span>
                {o.hint && <small>{o.hint}</small>}
              </span>
              {o.value === value && <IconCheck className="check" size={15} />}
            </div>
          ))}
        </div>,
      )}
    </>
  );
}

/* ───────────── DatePicker (calendar popover) ───────────── */

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];
const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fromIso = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const addMonths = (d: Date, n: number) => {
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  return new Date(t.getFullYear(), t.getMonth(), Math.min(d.getDate(), new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate()));
};
const monthLabel = (d: Date) => {
  const s = d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
export const formatDate = (s: string) => fromIso(s).toLocaleDateString("en-US", { day: "numeric", month: "short", year: "numeric" });

export function DatePicker({
  value,
  onChange,
  label,
  ariaLabel,
  Icon = IconCalendar,
  tip,
  emptyText = "today",
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  ariaLabel: string;
  Icon?: (p: IconProps) => ReactNode;
  tip?: string;
  /** Shown when no date is picked ("today" for an as-of date, "none" for an optional due date). */
  emptyText?: string;
}) {
  const pop = usePopover();
  const id = useId();
  const today = useMemo(() => new Date(), []);
  const [focus, setFocus] = useState<Date>(value ? fromIso(value) : today);
  const gridRef = useRef<HTMLDivElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (pop.isOpen) setFocus(value ? fromIso(value) : new Date());
  }, [pop.isOpen, value]);

  // Focus the roving day on open and after keyboard moves; mouse clicks on the month arrows keep their focus.
  useEffect(() => {
    if (!pop.isOpen) return;
    const raf = requestAnimationFrame(() => gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(raf);
  }, [pop.isOpen]);
  useEffect(() => {
    if (!moved.current) return;
    moved.current = false;
    gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus({ preventScroll: true });
  }, [focus]);

  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const start = addDays(first, -((first.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => addDays(start, i));
  const todayIso = toIso(today);

  const choose = (d: Date) => {
    onChange(toIso(d));
    pop.close(true);
  };

  function onGridKey(e: React.KeyboardEvent) {
    const map: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      PageUp: () => addMonths(focus, e.shiftKey ? -12 : -1),
      PageDown: () => addMonths(focus, e.shiftKey ? 12 : 1),
      Home: () => addDays(focus, -((focus.getDay() + 6) % 7)),
      End: () => addDays(focus, 6 - ((focus.getDay() + 6) % 7)),
    };
    if (map[e.key]) {
      e.preventDefault();
      moved.current = true;
      setFocus(map[e.key]());
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      choose(focus);
    }
  }

  return (
    <span className={`date-chip${value ? " is-set" : ""}`} data-tip={tip}>
      <button
        ref={pop.anchorRef}
        type="button"
        className="date-trigger"
        aria-haspopup="dialog"
        aria-expanded={pop.isOpen}
        aria-controls={`${id}-cal`}
        aria-label={value ? `${ariaLabel}: ${formatDate(value)}` : ariaLabel}
        onClick={pop.toggle}
        onKeyDown={(e) => e.key === "ArrowDown" && (e.preventDefault(), pop.open())}
      >
        <Icon size={15} variant={value ? "duotone" : "stroke"} />
        {label}
        <span className="date-value">{value ? formatDate(value) : emptyText}</span>
      </button>
      {value && (
        <button type="button" className="date-clear" aria-label="Clear date" onClick={() => onChange("")}>
          <IconX size={12} strokeWidth={2.2} />
        </button>
      )}
      {pop.render(
        <div
          ref={pop.floatRef}
          id={`${id}-cal`}
          role="dialog"
          aria-label={ariaLabel}
          className={`menu floating calendar ${pop.cls}`}
          data-origin={pop.origin}
          style={pop.style}
          inert={!pop.isOpen}
          // Closing returns focus to the trigger, so Tab then continues from there into the form.
          onKeyDown={(e) => e.key === "Tab" && pop.close(true)}
        >
          <div className="cal-head">
            <button type="button" className="quiet icon small" aria-label="Previous month" onClick={() => setFocus(addMonths(focus, -1))}>
              <IconChevronLeft size={16} />
            </button>
            <span className="cal-title" aria-live="polite">
              {monthLabel(focus)}
            </span>
            <button type="button" className="quiet icon small" aria-label="Next month" onClick={() => setFocus(addMonths(focus, 1))}>
              <IconChevronRight size={16} />
            </button>
          </div>
          <div className="cal-grid" role="grid" aria-label={monthLabel(focus)} ref={gridRef} onKeyDown={onGridKey}>
            <div role="row" className="cal-row">
              {WEEKDAYS.map((w, i) => (
                <span key={i} role="columnheader" className="cal-wd">
                  {w}
                </span>
              ))}
            </div>
            {Array.from({ length: 6 }, (_, r) => (
              <div role="row" className="cal-row" key={r}>
                {days.slice(r * 7, r * 7 + 7).map((d) => {
                  const iso = toIso(d);
                  const isFocus = iso === toIso(focus);
                  return (
                    <button
                      key={iso}
                      type="button"
                      role="gridcell"
                      tabIndex={isFocus ? 0 : -1}
                      aria-selected={iso === value}
                      aria-current={iso === todayIso ? "date" : undefined}
                      aria-label={d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                      className={`cal-day${d.getMonth() !== focus.getMonth() ? " is-out" : ""}`}
                      onClick={() => choose(d)}
                    >
                      {d.getDate()}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <div className="cal-foot">
            <button type="button" className="quiet small" onClick={() => choose(new Date())}>
              Today
            </button>
            {value && (
              <button
                type="button"
                className="quiet small"
                onClick={() => {
                  onChange("");
                  pop.close(true);
                }}
              >
                Clear date
              </button>
            )}
          </div>
        </div>,
      )}
    </span>
  );
}

/* ───────────── Confirm dialog (replaces window.confirm) ───────────── */

interface ConfirmOpts {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "danger" | "default";
}
type ConfirmFn = (o: ConfirmOpts) => Promise<boolean>;
const ConfirmCtx = createContext<ConfirmFn>(async () => false);
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [shown, setShown] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const id = useId();

  const confirm = useCallback<ConfirmFn>(
    (o) =>
      new Promise<boolean>((resolve) => {
        restore.current = document.activeElement as HTMLElement | null;
        setReq({ ...o, resolve });
      }),
    [],
  );

  const settle = useCallback(
    (v: boolean) => {
      if (!req) return;
      req.resolve(v);
      setShown(false);
      setTimeout(() => {
        setReq(null);
        restore.current?.focus?.();
      }, 180);
    },
    [req],
  );

  useEffect(() => {
    if (!req) return;
    const raf = requestAnimationFrame(() => {
      setShown(true);
      boxRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") settle(false);
      if (e.key === "Tab" && boxRef.current) {
        const f = Array.from(boxRef.current.querySelectorAll<HTMLElement>("button"));
        const i = f.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener("keydown", onKey);
    };
  }, [req, settle]);

  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {req &&
        createPortal(
          <div className={`dialog-layer${shown ? " is-open" : ""}`} onPointerDown={(e) => e.target === e.currentTarget && settle(false)}>
            <div ref={boxRef} className="dialog" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-t`} aria-describedby={req.body ? `${id}-b` : undefined}>
              <button type="button" className="dialog-close" aria-label="Close" onClick={() => settle(false)}>
                <IconX size={16} />
              </button>
              <span className={`dialog-icon${req.tone === "danger" ? " danger" : ""}`}>
                <IconAlert size={20} variant="duotone" />
              </span>
              <h2 id={`${id}-t`}>{req.title}</h2>
              {req.body && (
                <p id={`${id}-b`} className="muted">
                  {req.body}
                </p>
              )}
              <div className="dialog-actions">
                <button type="button" className="ghost" data-autofocus onClick={() => settle(false)}>
                  {req.cancelLabel ?? "Cancel"}
                </button>
                <button type="button" className={req.tone === "danger" ? "destructive" : "primary"} onClick={() => settle(true)}>
                  {req.confirmLabel ?? "Confirm"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </ConfirmCtx.Provider>
  );
}

/* ───────────── TextField + validation (replaces the browser's bubbles) ───────────── */

function message(el: HTMLInputElement) {
  const v = el.validity;
  if (v.valueMissing) return el.type === "email" ? "Enter an email." : "This field is required.";
  if (v.typeMismatch && el.type === "email") return "Enter a valid email, like name@company.com.";
  if (v.tooShort) return `Use at least ${el.minLength} characters.`;
  if (v.tooLong) return `Use at most ${el.maxLength} characters.`;
  return "Check this field.";
}

/** Forms set noValidate; call validate(form) on submit and spread field(name) into each TextField. */
export function useFormErrors() {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const validate = useCallback((form: HTMLFormElement) => {
    const next: Record<string, string> = {};
    let firstEl: HTMLInputElement | null = null;
    for (const el of Array.from(form.elements)) {
      if (!(el instanceof HTMLInputElement) || !el.name || el.validity.valid) continue;
      next[el.name] = message(el);
      firstEl ??= el;
    }
    setErrors(next);
    firstEl?.focus();
    return !firstEl;
  }, []);
  const field = useCallback(
    (name: string) => ({
      name,
      error: errors[name],
      onInput: () => setErrors((e) => (e[name] ? Object.fromEntries(Object.entries(e).filter(([k]) => k !== name)) : e)),
    }),
    [errors],
  );
  return { validate, field };
}

/** Collapsed card for settings most people never need. Closed by default; defaults already apply. */
export function Disclosure({
  title,
  hint,
  children,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  id: sectionId,
  icon,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
  defaultOpen?: boolean;
  /** Controlled mode (e.g. a section nav that opens it on jump). */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Section anchor id; also marks it for the editor's section nav. */
  id?: string;
  /** Optional leading icon, same slot as the editor section headers. */
  icon?: ReactNode;
}) {
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const id = useId();
  const toggle = () => {
    setOpenState(!open);
    onOpenChange?.(!open);
  };
  return (
    <section className="card ed-section disclosure" data-open={open} id={sectionId} data-ed-section={sectionId ? "" : undefined}>
      <button type="button" className="disclosure-head" aria-expanded={open} aria-controls={id} onClick={toggle}>
        {icon && (
          <span className="ed-ico" aria-hidden="true">
            {icon}
          </span>
        )}
        <span className="disclosure-title">
          <strong>{title}</strong>
          {hint && <small>{hint}</small>}
        </span>
        <IconChevronDown className="chev" size={16} />
      </button>
      <div className="acc-panel" id={id} inert={!open}>
        <div className="acc-inner">
          <div className="disclosure-body">{children}</div>
        </div>
      </div>
    </section>
  );
}

export function TextField({
  label,
  icon: Icon,
  error,
  className,
  ...input
}: InputHTMLAttributes<HTMLInputElement> & { label?: string; icon?: (p: IconProps) => ReactNode; error?: string }) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <div className={`field${className ? ` ${className}` : ""}`} data-invalid={error ? "" : undefined}>
      {label && <label htmlFor={id}>{label}</label>}
      <span className={`input-wrap${Icon ? " has-icon" : ""}`}>
        {Icon && <Icon size={16} className="lead-icon" />}
        <input id={id} aria-invalid={error ? true : undefined} aria-describedby={error ? errId : undefined} {...input} />
      </span>
      <span className="field-error" id={errId} role="alert" aria-hidden={!error}>
        <span>
          <IconAlert size={13} />
          {error}
        </span>
      </span>
    </div>
  );
}
