"use client";

import "blobatar/motion.css";
import { animate, motion, useMotionValue } from "motion/react";
import { useRef, useState, type KeyboardEvent } from "react";
import { clamp, springFromResponse, stretch } from "@/lib/fluid/physics";
import { useDrag } from "@/lib/fluid/use-drag";
import { useMotionPreference } from "@/lib/fluid/use-motion-preference";
import { DitherField } from "./DitherField";
import { IconMinus, IconPlus, IconUser } from "./icons";
import { SoftText } from "./motion";
import { useLocale } from "./LocaleProvider";
import { Avatar } from "./ui";

const TEXT = {
  en: { seats: "Seats", size: "Team size", left: (n: number) => `${n} left`, remove: "Remove a seat", add: "Add a seat", note: "Plans are priced per organization, never per seat. Add everyone who needs answers.", seat: (i: number) => `seat ${i}` },
  es: { seats: "Puestos", size: "Tamaño del equipo", left: (n: number) => `${n} libres`, remove: "Quitar un puesto", add: "Añadir un puesto", note: "Los planes se cobran por organización, nunca por puesto. Añade a todas las personas que necesiten respuestas.", seat: (i: number) => `seat ${i}` },
};

const MIN = 1;
const MAX = 10;
/** Horizontal drag distance (px) that moves the count by one. */
const SCRUB_PX = 26;
const SEAT = springFromResponse(0.38, 0.86);
const SETTLE = springFromResponse(0.4, 0.9);

/**
 * Seat picker: ghost avatars fill in as the count grows. The number is also a scrubber —
 * drag it sideways to change the count; it leans with the finger under a rubber band and
 * springs home with the release speed.
 */
export function SeatStepper() {
  const t = TEXT[useLocale()];
  const [count, setCount] = useState(2);
  const countRef = useRef(count);
  const origin = useRef(count);
  const x = useMotionValue(0);
  const { spring } = useMotionPreference();

  const set = (next: number) => {
    const value = clamp(next, MIN, MAX);
    if (value === countRef.current) return;
    countRef.current = value;
    setCount(value);
  };

  const drag = useDrag({
    onStart: () => {
      x.stop();
      origin.current = countRef.current;
    },
    onMove: (delta) => {
      set(origin.current + Math.round(delta.x / SCRUB_PX));
      x.set(stretch(delta.x, 36));
    },
    onEnd: (velocity) => {
      animate(x, 0, { ...spring(SETTLE), velocity: velocity.x });
    },
  });

  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
    if (e.key === "Home") set(MIN);
    else if (e.key === "End") set(MAX);
    else if (step) set(countRef.current + step);
    else return;
    e.preventDefault();
  };

  const left = MAX - count;

  return (
    <div className="seats-stage">
    <DitherField className="seats-dither seats-dither-wide" pattern="waves" intensity={0.5} speed={0.4} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />
    <section className="seats" aria-label={t.seats}>
      <header>
        <h2>{t.size}</h2>
        <span className="seats-left" aria-live="polite">
          <IconUser size={13} variant="duotone" />
          <SoftText text={t.left(left)} />
        </span>
      </header>

      <div className="seats-row" aria-hidden="true">
        {Array.from({ length: MAX }, (_, i) => {
          const filled = i < count;
          return (
            <motion.span
              key={i}
              className="seat"
              initial={false}
              animate={{ scale: filled ? 1 : 0.8, opacity: filled ? 1 : 0.3, filter: filled ? "grayscale(0)" : "grayscale(1)" }}
              transition={spring(SEAT)}
            >
              <Avatar name={t.seat(i + 1)} animate={filled ? "hover" : undefined} />
            </motion.span>
          );
        })}
      </div>

      <div className="seats-stepper">
        <button type="button" aria-label={t.remove} disabled={count <= MIN} onClick={() => set(count - 1)}>
          <IconMinus size={16} />
        </button>
        <motion.div
          {...drag}
          style={{ x }}
          className="seats-count"
          role="spinbutton"
          tabIndex={0}
          aria-label={t.seats}
          aria-valuemin={MIN}
          aria-valuemax={MAX}
          aria-valuenow={count}
          onKeyDown={onKeyDown}
        >
          <SoftText text={String(count)} />
        </motion.div>
        <button type="button" aria-label={t.add} disabled={count >= MAX} onClick={() => set(count + 1)}>
          <IconPlus size={16} />
        </button>
      </div>

      <p className="seats-note">{t.note}</p>
    </section>
    </div>
  );
}
