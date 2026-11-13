"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { IconChevronLeft, IconChevronRight } from "@/components/icons";
import "./included.css";

export type IncludedItem = { art: string; title: string; text: string };

const EVERY = 5200; // ms a feature stays open before the next one opens

const pad = (n: number) => String(n).padStart(2, "0");

// A spring described by how long it takes to respond (s) and how much it bounces (1 = none).
const springFromResponse = (response: number, dampingRatio: number) => ({
  type: "spring" as const,
  stiffness: Math.pow((2 * Math.PI) / response, 2),
  damping: (4 * Math.PI * dampingRatio) / response,
  mass: 1,
});

// The number grows out of the folded slice with a small pop when its card opens and settles back
// when it folds. A spring keeps it interruptible: when the slider moves on mid-pop it turns from
// wherever it is, with the speed it had. Reduced motion jumps straight to the new size.
const POP = springFromResponse(0.5, 0.7);
const SETTLE = springFromResponse(0.4, 1);
const FOLDED = 0.5; // the folded number's size against the open one

/**
 * "Also included" as an expanding slider: the feature that is open fills most of the row with its
 * drawing and a line about it; the others fold into narrow slices that keep a strip of their drawing
 * and their number. Opening one folds the rest, and the row keeps its size, so nothing below
 * moves. It moves on by itself while in view and waits under the pointer or keyboard focus. Picking
 * a feature (a slice, the arrows or the arrow keys) hands control to the reader: it stops moving on.
 * With reduced motion it never moves on by itself.
 */
export function Included({ items }: { items: IncludedItem[] }) {
  const [active, setActive] = useState(0);
  const [auto, setAuto] = useState(true);
  const reduceMotion = useReducedMotion() ?? false;
  const track = useRef<HTMLDivElement>(null);
  const hold = useRef({ hover: false, focus: false, offscreen: true });
  const n = items.length;

  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) setAuto(false);
  }, []);

  useEffect(() => {
    const el = track.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      hold.current.offscreen = !entry?.isIntersecting;
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!auto) return;
    const id = setInterval(() => {
      const h = hold.current;
      if (h.hover || h.focus || h.offscreen || document.hidden) return;
      setActive((a) => (a + 1) % n);
    }, EVERY);
    return () => clearInterval(id);
  }, [auto, n]);

  function go(i: number, focus = false) {
    const next = (i + n) % n;
    setAuto(false);
    setActive(next);
    if (focus) track.current?.querySelectorAll<HTMLButtonElement>(".inc-card")[next]?.focus();
  }

  return (
    <>
      <h2>
        Also <em>included</em>.
      </h2>

      <div className="inc-nav">
        <span className="inc-count" aria-hidden="true">
          <b key={active}>{pad(active + 1)}</b> / {pad(n)}
        </span>
        <button type="button" className="inc-arrow" aria-label="Previous feature" onClick={() => go(active - 1)}>
          <IconChevronLeft size={16} />
        </button>
        <button type="button" className="inc-arrow" aria-label="Next feature" onClick={() => go(active + 1)}>
          <IconChevronRight size={16} />
        </button>
      </div>

      <div
        ref={track}
        className="inc"
        role="group"
        aria-roledescription="carousel"
        aria-label="Also included"
        style={{ ["--n" as string]: n }}
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") hold.current.hover = true;
        }}
        onPointerLeave={() => {
          hold.current.hover = false;
        }}
        onFocus={(e) => {
          if (e.target.matches(":focus-visible")) hold.current.focus = true;
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold.current.focus = false;
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "ArrowDown") {
            e.preventDefault();
            go(active + 1, true);
          } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
            e.preventDefault();
            go(active - 1, true);
          }
        }}
      >
        {items.map(({ art, title, text }, k) => {
          const open = k === active;
          return (
            <button
              key={title}
              type="button"
              className="inc-card"
              aria-current={open ? "true" : undefined}
              aria-label={`${title}. ${text} (${k + 1} of ${n})`}
              tabIndex={open ? 0 : -1}
              onClick={() => go(k)}
            >
              <span className="inc-art ill" aria-hidden="true">
                <img className="ill-light" src={`/illustrations/${art}.svg`} width={1651} height={953} alt="" loading="lazy" decoding="async" />
                <img className="ill-dark" src={`/illustrations/${art}-dark.svg`} width={1651} height={953} alt="" loading="lazy" decoding="async" />
              </span>
              <span className="inc-n" aria-hidden="true">
                <motion.span
                  className="inc-n-num"
                  initial={false}
                  animate={{ scale: open ? 1 : FOLDED }}
                  transition={reduceMotion ? { duration: 0 } : open ? POP : SETTLE}
                >
                  {pad(k + 1)}
                </motion.span>
              </span>
              <span className="inc-body" aria-hidden="true">
                <strong>{title}</strong>
                <span>{text}</span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
