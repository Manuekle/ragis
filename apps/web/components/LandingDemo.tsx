"use client";

import { avatarStyle } from "@/components/ui";
import { Homemade_Apple } from "next/font/google";
import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { FileTile } from "@/components/FileTile";
import { LogoMark } from "@/components/Logo";
import { typewriter } from "@/components/paperFont";
import { IconCheck, IconFiles, IconHourglass, IconLock, IconSend, IconShield, IconSignature } from "@/components/icons";

/*
 * Hero product story. One expense claim goes through Ragis in a single, unbroken take:
 * it is read (a scan beam passes over the paper and each field lands in the panel as the beam
 * crosses it), checked against policy (a cited answer, while a pen circles the figures on the
 * paper), approved by a person (check + confetti), then signed, stamped and logged. Then it loops.
 *
 * One clock drives everything. Pieces read it through `useAfter` / `useProgress`, which re-render
 * only when their own answer changes. The clock stops off screen, in a background tab and under the
 * pointer. With reduced motion it stands still on the cited answer, the moment the hero is about.
 */

// Handwriting for the signature: legible, self-hosted by next/font at build time.
const hand = Homemade_Apple({ weight: "400", subsets: ["latin"], display: "swap" });

// ───────────── timeline (ms) ─────────────

// Authored at a brisk pace, played 1.2× slower so each step has room to breathe.
const PACE = 1.2;
const RAW = {
  scan: [700, 2900] as const,
  // when the beam crosses each row of the paper (row centre / paper height × sweep)
  rows: { name: 1270, trip: 1540, days: 1800, lodging: 2040, purpose: 2330 },
  mask: 3150,
  ask: 3600,
  type: [3850, 4650] as const,
  answer: 5000,
  circleAmount: 5500,
  circleDays: 5950,
  source: 6300,
  verified: 6700,
  approve: 7800,
  approved: 9200,
  seal: 10800,
  sign: [11000, 12500] as const,
  stamp: 12600,
  leave: 15000,
  end: 15700,
};
type Raw = typeof RAW;
const slow = (v: number) => Math.round(v * PACE);
const T = Object.fromEntries(
  Object.entries(RAW).map(([k, v]) => [k, typeof v === "number" ? slow(v) : Array.isArray(v) ? v.map(slow) : Object.fromEntries(Object.entries(v).map(([kk, vv]) => [kk, slow(vv as number)]))]),
) as unknown as Raw;
const POSTER = slow(7300); // reduced motion: the frame shown, fixed

// ───────────── clock ─────────────

type Clock = { t: number; subscribe: (fn: () => void) => () => void; emit: () => void };

function makeClock(): Clock {
  const fns = new Set<() => void>();
  return {
    t: 0,
    subscribe: (fn) => {
      fns.add(fn);
      return () => fns.delete(fn);
    },
    emit: () => fns.forEach((fn) => fn()),
  };
}

const ClockContext = createContext<Clock | null>(null);

function useClockValue<T>(read: (t: number) => T): T {
  const clock = useContext(ClockContext)!;
  return useSyncExternalStore(
    clock.subscribe,
    () => read(clock.t),
    () => read(0),
  );
}

const useAfter = (ms: number) => useClockValue((t) => t >= ms);
const useBetween = (from: number, to: number) => useClockValue((t) => t >= from && t < to);

/** 0…steps between `from` and `to`, optionally eased out. */
function useProgress(from: number, to: number, steps: number, ease = false) {
  return useClockValue((t) => {
    const p = Math.min(1, Math.max(0, (t - from) / (to - from)));
    return Math.round((ease ? 1 - Math.pow(1 - p, 3) : p) * steps);
  });
}

/** Adds `is-in` once the clock passes `at`. */
function In({ at, className, style, children, as: Tag = "div" }: { at: number; className?: string; style?: CSSProperties; children?: ReactNode; as?: "div" | "span" | "li" | "p" }) {
  const on = useAfter(at);
  return (
    <Tag className={`${className ?? ""}${on ? " is-in" : ""}`} style={style}>
      {children}
    </Tag>
  );
}

// ───────────── shell ─────────────

export function LandingDemo() {
  const [run, setRun] = useState(0);
  const [still, setStill] = useState(false);
  const clock = useRef<Clock>(null as unknown as Clock);
  if (!clock.current) clock.current = makeClock();
  const root = useRef<HTMLElement>(null);
  const hold = useRef({ hover: false, offscreen: true, hidden: false });

  useEffect(() => {
    const mq = matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setStill(mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => {
      hold.current.offscreen = !entry?.isIntersecting;
    });
    io.observe(el);
    const vis = () => {
      hold.current.hidden = document.visibilityState === "hidden";
    };
    vis();
    document.addEventListener("visibilitychange", vis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", vis);
    };
  }, []);

  useEffect(() => {
    const c = clock.current;
    if (still) {
      c.t = POSTER;
      c.emit();
      return;
    }
    c.t = 0;
    c.emit();
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // Real elapsed time, so the clock stays in step with the CSS animations it starts even on a slow
      // device. Only a long gap (a sleeping tab, a debugger pause) is treated as a single frame.
      const gap = now - last;
      const dt = gap > 250 ? 16 : gap;
      last = now;
      const h = hold.current;
      const held = h.hover || h.offscreen || h.hidden;
      // CSS animations (beam, confetti, pen) pause with the clock so they never drift from it.
      if (root.current && root.current.hasAttribute("data-paused") !== held) root.current.toggleAttribute("data-paused", held);
      if (!held) {
        c.t += dt;
        if (c.t >= T.end) {
          c.t = 0;
          setRun((r) => r + 1); // remount: every piece starts clean
        } else {
          c.emit();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still]);

  useEffect(() => {
    clock.current.emit();
  }, [run]);

  return (
    <figure
      ref={root}
      className="ld"
      data-still={still ? "" : undefined}
      onPointerEnter={(e) => {
        if (e.pointerType === "mouse") hold.current.hover = true;
      }}
      onPointerLeave={() => {
        hold.current.hover = false;
      }}
    >
      <figcaption className="sr-only">
        Ragis reads an expense claim, masks the personal data, checks the hotel cost against the travel policy with a cited answer, gets a manager&apos;s approval, then signs, stamps and logs it.
      </figcaption>
      <ClockContext.Provider value={clock.current}>
        <Story key={run} />
      </ClockContext.Provider>
    </figure>
  );
}

function Story() {
  const leaving = useAfter(T.leave);
  return (
    <div className="ld-story" data-leaving={leaving ? "" : undefined} aria-hidden="true">
      <Paper />
      <div className="ld-side">
        <Narration />
        <Panel />
      </div>
    </div>
  );
}

// ───────────── the paper ─────────────

const DAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];

/** The sweep itself is a CSS transform animation (compositor only); the clock only says when it runs. */
function Beam() {
  const on = useBetween(T.scan[0], T.scan[1] + 240);
  return <span className="ld-beam" data-on={on ? "" : undefined} style={{ ["--scan" as string]: `${T.scan[1] - T.scan[0]}ms` }} />;
}

/** A field on the paper: lights up as the beam crosses it. */
function Field({ at, label, children, className }: { at: number; label: string; children: ReactNode; className?: string }) {
  return (
    <In at={at} className={`ld-f${className ? ` ${className}` : ""}`}>
      <span className="ld-f-label">{label}</span>
      <span className="ld-f-value">{children}</span>
    </In>
  );
}

function Pen({ at, className, d, viewBox }: { at: number; className: string; d: string; viewBox: string }) {
  const on = useAfter(at);
  return (
    <svg viewBox={viewBox} className={`ld-pen ${className}`} data-on={on ? "" : undefined} preserveAspectRatio="none">
      <path d={d} pathLength={1} />
    </svg>
  );
}

function Paper() {
  const masked = useAfter(T.mask);
  const signing = useAfter(T.sign[0]);
  const stamped = useAfter(T.stamp);
  return (
    <div className={`ld-paper ${typewriter.variable}`} data-stamped={stamped ? "" : undefined}>
      <Beam />

      <div className="ld-p-head">
        <span className="ld-p-brand">
          <span>TRAVEL</span>
          <span>EXPENSE</span>
          <span>CLAIM</span>
        </span>
        <span className="ld-p-no">2411</span>
      </div>

      <Field at={T.rows.name} label="NAME" className="ld-f-name">
        <span className="ld-redact" data-on={masked ? "" : undefined}>
          Emily Carter
        </span>
      </Field>

      <div className="ld-p-split">
        <Field at={T.rows.trip} label="TRIP">
          San Francisco, CA
        </Field>
        <Field at={T.rows.trip} label="DATE">
          11/16/2026
        </Field>
      </div>

      <In at={T.rows.days} className="ld-days">
        {DAYS.map((d) => (
          <span key={d}>{d}</span>
        ))}
        <Pen at={T.circleDays} className="ld-pen-days" viewBox="0 0 120 30" d="M10 17C9 7 52 3 84 4c22 1 33 6 31 13-2 8-38 10-66 9C25 25 6 22 8 14 10 7 30 4 52 3" />
      </In>

      <div className="ld-p-split">
        <Field at={T.rows.lodging} label="LODGING">
          <span className="ld-amount">
            $412.80
            <Pen at={T.circleAmount} className="ld-pen-amount" viewBox="0 0 90 30" d="M8 15C7 6 40 2 66 4c16 1 22 6 20 12-3 8-30 11-52 10C14 25 3 20 6 12 9 6 26 3 44 3" />
          </span>
        </Field>
        <Field at={T.rows.lodging} label="NIGHTS">
          3
        </Field>
      </div>

      <Field at={T.rows.purpose} label="PURPOSE" className="ld-f-purpose">
        Bayview Hotel, client summit
      </Field>

      <div className="ld-p-foot">
        <span className="ld-f-label">SIGNATURE</span>
        <span className={`ld-p-sig ${hand.className}`} data-on={signing ? "" : undefined}>
          Michael Brooks
        </span>
        <Stamp />
      </div>
    </div>
  );
}

/** Rubber stamp: the supplied artwork as-is, whole, in the sheet's bottom-right corner. */
function Stamp() {
  return <img src="/illustrations/approved-stamp.svg" alt="" className="ld-stamp" draggable={false} />;
}

// ───────────── what Ragis is doing ─────────────

const LINES: { at: number; text: string; done?: boolean }[] = [
  { at: 0, text: "Reading the claim" },
  { at: T.mask, text: "Masking personal data" },
  { at: T.ask, text: "Checking the travel policy" },
  { at: T.verified, text: "Within policy", done: true },
  { at: T.approve, text: "Asking Michael to approve" },
  { at: T.approved, text: "Approved by Michael", done: true },
  { at: T.seal, text: "Signing and sealing" },
  { at: T.stamp + 600, text: "Paid and logged", done: true },
];

function Narration() {
  const i = useClockValue((t) => LINES.reduce((acc, l, k) => (t >= l.at ? k : acc), 0));
  const line = LINES[i]!;
  return (
    <div className="ld-narr">
      <span className="ld-narr-mark" data-done={line.done ? "" : undefined}>
        <LogoMark size={11} />
      </span>
      <span key={i} className={`ld-narr-text${line.done ? " is-done" : ""}`} data-text={line.text}>
        {line.text}
      </span>
    </div>
  );
}

const PHASES = [
  { at: 0, View: ReadPhase },
  { at: T.ask, View: AskPhase },
  { at: T.approve, View: ApprovePhase },
  { at: T.seal, View: SealPhase },
];

/** The panel shows one step at a time; the outgoing one lifts away as the next settles in. */
function Panel() {
  const i = useClockValue((t) => PHASES.reduce((acc, p, k) => (t >= p.at ? k : acc), 0));
  const [prev, setPrev] = useState<number | null>(null);
  const last = useRef(i);
  useEffect(() => {
    if (last.current === i) return;
    setPrev(last.current);
    last.current = i;
    const t = setTimeout(() => setPrev(null), 360);
    return () => clearTimeout(t);
  }, [i]);
  const Cur = PHASES[i]!.View;
  const Prev = prev !== null ? PHASES[prev]!.View : null;
  return (
    <div className="ld-panel">
      {Prev && (
        <div key={`p${prev}`} className="ld-phase is-exit">
          <Prev />
        </div>
      )}
      <div key={`c${i}`} className="ld-phase">
        <Cur />
      </div>
    </div>
  );
}

// 1 · read: each field arrives as the beam crosses it on the paper
function ReadPhase() {
  const masked = useAfter(T.mask);
  const rows: { at: number; label: string; value: ReactNode }[] = [
    {
      at: T.rows.name,
      label: "Employee",
      value: (
        <span className="ld-x-mask">
          <span className="ld-redact" data-on={masked ? "" : undefined}>
            Emily Carter
          </span>
          <span className="ld-x-tag" data-on={masked ? "" : undefined}>
            <IconShield size={11} />
            masked
          </span>
        </span>
      ),
    },
    { at: T.rows.trip, label: "Trip", value: "San Francisco · Nov 10–13" },
    { at: T.rows.days, label: "Stay", value: "Tue → Thu" },
    { at: T.rows.lodging, label: "Lodging", value: "$412.80 · 3 nights" },
    { at: T.rows.purpose, label: "Purpose", value: "Client summit" },
  ];
  return (
    <ul className="ld-x">
      {rows.map((r) => (
        <In key={r.label} at={r.at + 60} as="li" className="ld-rise ld-x-row">
          <span className="ld-x-label">{r.label}</span>
          <span className="ld-x-value">{r.value}</span>
        </In>
      ))}
    </ul>
  );
}

// 2 · ask: a cited answer, while the pen circles the figures it used
const QUESTION = "Is the hotel within policy?";
const ANSWER: (string | number)[] = ["Yes.", "$412.80", "over", "3", "nights", "is", "$137.60", "a", "night,", "under", "the", "$180", "limit", 1, "."];

function AskPhase() {
  const typed = useProgress(T.type[0], T.type[1], QUESTION.length);
  const answering = useAfter(T.answer);
  let w = 0;
  return (
    <div className="ld-ask">
      <p className="ld-q" data-typing={typed < QUESTION.length ? "" : undefined}>
        {QUESTION.slice(0, typed)}
        <span className="ld-q-ghost">{QUESTION.slice(typed)}</span>
      </p>
      <p className={`ld-answer${answering ? " is-in" : ""}`}>
        {ANSWER.map((tok, k) => {
          const style = { transitionDelay: `${w++ * 45}ms` };
          if (typeof tok === "number")
            return (
              <span key={k} className="ld-cite t-stream-w" style={style}>
                {tok}
              </span>
            );
          return (
            <span key={k}>
              {k > 0 && tok !== "." ? " " : ""}
              <span className="t-stream-w" style={style}>
                {tok}
              </span>
            </span>
          );
        })}
      </p>
      <div className="ld-sources">
        <In at={T.source} as="span" className="ld-rise ld-src">
          <span className="ld-src-n">1</span>
          <FileTile ext="pdf" size={16} />
          Travel &amp; Expense Policy
          <span className="ld-src-loc">p. 4</span>
        </In>
        <In at={T.verified} as="span" className="ld-rise ld-verified">
          <i className="land-dot" aria-hidden="true" />
          Verified
        </In>
      </div>
    </div>
  );
}

// 3 · approve: a person decides; the check lands with a little confetti
const BITS: { x: number; y: number; c: string; k: "dot" | "sm" | "squiggle" | "arc"; r: number }[] = [
  { x: -62, y: -30, c: "#a855f7", k: "dot", r: 0 },
  { x: -46, y: 10, c: "#f5b83d", k: "dot", r: 0 },
  { x: -78, y: 18, c: "#5ccff0", k: "squiggle", r: -12 },
  { x: -40, y: 40, c: "#5fbf3f", k: "dot", r: 0 },
  { x: -18, y: -46, c: "#a855f7", k: "sm", r: 0 },
  { x: 6, y: -44, c: "#f5b83d", k: "sm", r: 0 },
  { x: 54, y: -40, c: "#ec4f86", k: "squiggle", r: 28 },
  { x: 58, y: -2, c: "#5ccff0", k: "dot", r: 0 },
  { x: 44, y: 34, c: "#f5b83d", k: "arc", r: 30 },
  { x: 18, y: 46, c: "#0ea5b7", k: "dot", r: 0 },
  { x: -6, y: 46, c: "#5fbf3f", k: "sm", r: 0 },
  { x: 72, y: 20, c: "#a855f7", k: "sm", r: 0 },
];

function Confetti() {
  return (
    <span className="ld-confetti" aria-hidden="true">
      {BITS.map((b, i) => (
        <i
          key={i}
          className={`ld-bit ld-bit-${b.k}`}
          style={{ ["--x" as string]: `${b.x}px`, ["--y" as string]: `${b.y}px`, ["--c" as string]: b.c, ["--r" as string]: `${b.r}deg`, ["--d" as string]: `${(i % 4) * 25}ms` }}
        >
          {b.k === "squiggle" && (
            <svg viewBox="0 0 24 16">
              <path d="M2 12c3 0 4-8 8-8s3 8 7 8 4-6 5-8" />
            </svg>
          )}
          {b.k === "arc" && (
            <svg viewBox="0 0 16 16">
              <path d="M3 3c6 1 10 5 10 10" />
            </svg>
          )}
        </i>
      ))}
    </span>
  );
}

function ApprovePhase() {
  const approved = useAfter(T.approved);
  return (
    <div className="ld-approve">
      <In at={T.approve + 150} className="ld-rise ld-person">
        <span className="avatar ld-avatar" style={avatarStyle("Michael Brooks")} aria-hidden="true" />
        <span className="ld-person-name">
          Michael Brooks
          <span>Finance lead</span>
        </span>
        <span className="ld-status" data-state={approved ? "ok" : "wait"}>
          <span className="ld-status-label" data-for="wait">
            <IconHourglass size={12} />
            Reviewing
          </span>
          <span className="ld-status-label" data-for="ok">
            <IconCheck size={12} />
            Approved · 10:44
          </span>
        </span>
      </In>

      <div className="ld-verdict" data-on={approved ? "" : undefined}>
        <span className="ld-check">
          {approved && <Confetti />}
          <svg viewBox="0 0 24 24" className="ld-check-mark" aria-hidden="true">
            <path d="M6.5 12.5l3.6 3.4 7.4-8" pathLength={1} />
          </svg>
        </span>
        <span className="ld-verdict-text">
          <strong>{approved ? "Approved" : "Waiting for approval"}</strong>
          <span>$412.80 · within policy</span>
        </span>
      </div>
    </div>
  );
}

// 4 · seal: signed, stamped, paid, on the record
const TRAIL = [
  { Icon: IconSignature, text: "Signed by Michael Brooks", meta: "10:44", at: T.sign[0] + 200 },
  { Icon: IconLock, text: "Stamped and sealed", meta: "sha-256 9f3a…c21e", at: T.stamp + 150, mono: true },
  { Icon: IconSend, text: "Reimbursement sent", meta: "$412.80", at: T.stamp + 650, mono: true },
  { Icon: IconFiles, text: "Logged to the audit trail", meta: "EX-2411", at: T.stamp + 1150, mono: true },
];

function SealPhase() {
  return (
    <ol className="ld-trail">
      {TRAIL.map((r) => (
        <In key={r.text} at={r.at} as="li" className="ld-rise ld-trail-row">
          <span className="ld-trail-ico">
            <r.Icon size={13} />
          </span>
          <span className="ld-trail-text">{r.text}</span>
          <span className={r.mono ? "ld-trail-meta mono" : "ld-trail-meta"}>{r.meta}</span>
        </In>
      ))}
    </ol>
  );
}
