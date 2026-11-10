"use client";

// Small React wrappers around the transitions.dev recipes in globals.css.
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes } from "react";
import { CheckMark, IconCheck } from "./icons";

const DROPDOWN_CLOSE_MS = 150;

/** t-dropdown: .is-open / .is-closing with cleanup so the next open starts from the pre-open scale. */
export function useDropdown() {
  const [state, setState] = useState<"closed" | "open" | "closing">("closed");
  const ref = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const close = useCallback(() => {
    setState((s) => (s === "open" ? "closing" : s));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState((s) => (s === "closing" ? "closed" : s)), DROPDOWN_CLOSE_MS);
  }, []);
  const open = useCallback(() => {
    clearTimeout(timer.current);
    setState("open");
  }, []);
  const toggle = useCallback(() => (state === "open" ? close() : open()), [state, open, close]);

  useEffect(() => {
    if (state !== "open") return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [state, close]);

  useEffect(() => () => clearTimeout(timer.current), []);

  const cls = `t-dropdown${state === "open" ? " is-open" : state === "closing" ? " is-closing" : ""}`;
  return { ref, isOpen: state === "open", toggle, close, cls };
}

/** t-toast: rises in, holds, then drops out faster than it came in. */
export function Toast({ message, onDone, ms = 2600 }: { message: string | null; onDone: () => void; ms?: number }) {
  const [shown, setShown] = useState(false);
  const [text, setText] = useState(message);

  useEffect(() => {
    if (!message) return;
    setText(message);
    setShown(false);
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
    const hide = setTimeout(() => setShown(false), ms);
    const done = setTimeout(onDone, ms + 260);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(hide);
      clearTimeout(done);
    };
  }, [message, ms, onDone]);

  return (
    <div className="toast-host" role="status" aria-live="polite">
      {text && (
        <div className={`t-toast${shown ? " is-open" : ""}`}>
          <IconCheck size={16} />
          {text}
        </div>
      )}
    </div>
  );
}

/** t-think: shimmering status line that swaps to the next state every `hold` ms. */
export function ThinkingStates({ states, hold = 1800 }: { states: string[]; hold?: number }) {
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<"idle" | "swap">("idle");
  const [prev, setPrev] = useState<number | null>(null);
  const enterRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (i >= states.length - 1) return; // hold on the last state until the answer lands
    const t = setTimeout(() => {
      setPrev(i);
      setI(i + 1);
      setPhase("swap");
    }, hold);
    return () => clearTimeout(t);
  }, [i, hold, states.length]);

  useLayoutEffect(() => {
    if (phase !== "swap" || !enterRef.current) return;
    const el = enterRef.current;
    el.classList.add("is-enter-start");
    void el.offsetWidth;
    el.classList.remove("is-enter-start");
    const t = setTimeout(() => {
      setPrev(null);
      setPhase("idle");
    }, 200);
    return () => clearTimeout(t);
  }, [phase, i]);

  const longest = states.reduce((a, b) => (b.length > a.length ? b : a), "");
  return (
    <span className="t-think" role="status">
      <span className="t-think-sizer" aria-hidden="true">
        {longest}
      </span>
      {prev !== null && (
        <span key={`p${prev}`} className="t-think-text is-exit" data-text={states[prev]} aria-hidden="true">
          {states[prev]}
        </span>
      )}
      <span key={`c${i}`} ref={enterRef} className="t-think-text" data-text={states[i]}>
        {states[i]}
      </span>
    </span>
  );
}

/**
 * t-stream: resolves words one by one through a soft cross-blur.
 * Citation markers [n] become clickable chips. Total reveal is capped so long answers don't drag.
 */
export function StreamText({ text, animate, onCite }: { text: string; animate: boolean; onCite: (n: number) => void }) {
  const [on, setOn] = useState(!animate);
  useEffect(() => {
    if (!animate) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  const tokens = text.split(/(\[\d{1,2}\]|\s+)/g).filter((t) => t !== "");
  const words = tokens.filter((t) => !/^\s+$/.test(t)).length || 1;
  const gap = Math.min(28, 1400 / words);
  let w = 0;

  return (
    <div className={`answer${on ? " is-in" : ""}`}>
      {tokens.map((tok, k) => {
        if (/^\s+$/.test(tok)) return <Fragment key={k}>{tok}</Fragment>;
        const delay = animate ? `${Math.round(w++ * gap)}ms` : "0ms";
        const m = tok.match(/^\[(\d{1,2})\]$/);
        if (m) {
          const n = Number(m[1]);
          return (
            <button key={k} type="button" className="cite-ref t-stream-w" style={{ transitionDelay: delay }} onClick={() => onCite(n)} aria-label={`View source ${n}`}>
              {n}
            </button>
          );
        }
        return (
          <span key={k} className="t-stream-w" style={{ transitionDelay: delay }}>
            {tok}
          </span>
        );
      })}
    </div>
  );
}

/** t-check: box fills, then the mark strokes in. */
export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: React.ReactNode }) {
  return (
    <label className="check-label">
      <button type="button" role="checkbox" aria-checked={checked} className="t-check" style={{ ["--check-len" as string]: 1 }} onClick={() => onChange(!checked)}>
        <CheckMark size={13} />
      </button>
      {label}
    </label>
  );
}

/** Cross-fade two icons in one slot (scale 0.25→1, blur 4px→0, 300ms). */
export function Swap({ on, a, b }: { on: boolean; a: React.ReactNode; b: React.ReactNode }) {
  return (
    <span className="swap">
      <span data-on={!on}>{a}</span>
      <span data-on={on}>{b}</span>
    </span>
  );
}

/**
 * t-tabs: segmented control whose active pill slides between options.
 * Drop-in for `<div className="seg">`: buttons keep using `aria-pressed`; the pill follows the pressed one.
 */
export function Seg({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const barRef = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  const place = useCallback((animate: boolean) => {
    const bar = barRef.current;
    const pill = pillRef.current;
    if (!bar || !pill) return;
    const tab = bar.querySelector<HTMLElement>('button[aria-pressed="true"]');
    if (!tab) {
      pill.style.opacity = "0";
      placed.current = false;
      return;
    }
    const top = `${tab.offsetTop}px`;
    const snap = !animate || !placed.current || pill.style.top !== top;
    if (snap) pill.style.transition = "none";
    pill.style.top = top;
    pill.style.height = `${tab.offsetHeight}px`;
    pill.style.width = `${tab.offsetWidth}px`;
    pill.style.transform = `translateX(${tab.offsetLeft}px)`;
    pill.style.opacity = "1";
    if (snap) {
      void pill.offsetWidth; // flush so the first position never animates
      pill.style.transition = "";
      placed.current = true;
    }
    bar.dataset.slide = "";
  }, []);

  // Every render: the pressed tab may have changed (animate) or its width may have (counts loading).
  useLayoutEffect(() => place(true));

  // Resize, font load or breakpoint change: snap without animating.
  useEffect(() => {
    const bar = barRef.current;
    if (!bar || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => place(false));
    ro.observe(bar);
    for (const button of bar.querySelectorAll("button")) ro.observe(button);
    return () => ro.disconnect();
  }, [place]);

  return (
    <div ref={barRef} className={className ? `seg ${className}` : "seg"} {...rest}>
      <span ref={pillRef} className="seg-pill" aria-hidden="true" />
      {children}
    </div>
  );
}

/**
 * t-text-soft: swaps a value in place with a cross-blur (no movement); the width eases so neighbours glide.
 * Use for values that change because the data behind the view changed (prices, totals, counts).
 */
export function SoftText({ text, align }: { text: string; align?: "end" }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [cur, setCur] = useState(text);
  const [swap, setSwap] = useState<{ from: string; to: string; w0: number } | null>(null);

  useLayoutEffect(() => {
    if (text === cur) return;
    const el = ref.current;
    if (!el) return;
    setSwap({ from: swap ? swap.to : cur, to: text, w0: el.getBoundingClientRect().width });
    setCur(text);
  }, [text, cur, swap]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!swap || !el) return;
    const inn = el.querySelector<HTMLElement>(".t-text-soft-new");
    const w1 = inn?.getBoundingClientRect().width ?? swap.w0;
    el.classList.remove("is-swapping");
    el.style.width = `${swap.w0}px`;
    void el.offsetWidth; // flush so the blur and the width tween both run
    el.classList.add("is-swapping");
    el.style.width = `${w1}px`;
    const t = setTimeout(() => {
      el.classList.remove("is-swapping");
      el.style.removeProperty("width");
      setSwap(null);
    }, 280);
    return () => clearTimeout(t);
  }, [swap]);

  return (
    <span ref={ref} className="t-text-soft" style={align ? ({ ["--text-soft-align" as string]: align }) : undefined}>
      {swap ? (
        <>
          <span className="t-text-soft-old" aria-hidden="true">
            {swap.from}
          </span>
          <span className="t-text-soft-new">{swap.to}</span>
        </>
      ) : (
        cur
      )}
    </span>
  );
}
