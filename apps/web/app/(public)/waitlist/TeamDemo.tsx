"use client";

import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { FileTile } from "@/components/FileTile";
import { LogoMark } from "@/components/Logo";
import { typewriter } from "@/components/paperFont";
import "./team-demo.css";

/*
 * "What it does" and "who it's for" in one picture, told the way the landing hero tells its story
 * (components/LandingDemo.tsx). The heading names a team ("Your files answer your legal team") and
 * the stage below plays one of its everyday questions: Ragis pulls the right file off the pile, a
 * scan beam reads the page, the passage is highlighted, and the answer arrives with the page it came
 * from while a pen circles the figure it used. Then the team in the heading changes and the next
 * story plays.
 *
 * One clock drives everything. Pieces read it through `useAfter` / `useProgress`, which re-render
 * only when their own answer changes. The clock stops off screen and in a background tab. Under the
 * pointer a team still plays to its answer, but the demo waits there instead of moving on. With
 * reduced motion nothing plays: the first team shows its finished, cited answer.
 */

type Team = {
  id: string;
  name: string;
  /** How the heading names the team: "Your files answer your … team". */
  word: string;
  files: { ext: string; name: string }[];
  question: string;
  /** No closing period: the citation goes before it. */
  answer: string;
  source: { ext: string; name: string; where: string };
  /** The source page as it sits on the desk. */
  doc: { kicker: string; title: string; no: string; body: ReactNode; foot: ReactNode };
};

// ───────────── timeline (ms) ─────────────

const T = {
  type: [400, 1500] as const,
  search: 1700,
  found: 2700,
  scan: [2900, 4300] as const,
  // the beam crosses the passage about here
  mark: 3600,
  answer: 4500,
  pen: 5100,
  source: 5500,
  verified: 5900,
  leave: 9400,
  end: 10000,
};
const POSTER = T.verified + 600; // reduced motion: the frame shown, fixed

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

function useClockValue<V>(read: (t: number) => V): V {
  const clock = useContext(ClockContext)!;
  return useSyncExternalStore(
    clock.subscribe,
    () => read(clock.t),
    () => read(0),
  );
}

const useAfter = (ms: number) => useClockValue((t) => t >= ms);

/** 0…steps between `from` and `to`. */
function useProgress(from: number, to: number, steps: number) {
  return useClockValue((t) => Math.round(Math.min(1, Math.max(0, (t - from) / (to - from))) * steps));
}

/** Adds `is-in` once the clock passes `at`. */
function In({ at, className, style, children, as: Tag = "div" }: { at: number; className?: string; style?: CSSProperties; children?: ReactNode; as?: "div" | "span" | "li" }) {
  const on = useAfter(at);
  return (
    <Tag className={`${className ?? ""}${on ? " is-in" : ""}`} style={style}>
      {children}
    </Tag>
  );
}

// ───────────── the page on the desk ─────────────

/** Highlighter over the passage the answer comes from, swept on once the beam has read it. */
function Mark({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const on = useAfter(T.mark + delay);
  return (
    <mark className="td-mark" data-on={on ? "" : undefined}>
      {children}
    </mark>
  );
}

/** A pen loop drawn around the figure the answer quotes, slightly past its own start like a real one. */
function Circle({ children }: { children: ReactNode }) {
  const on = useAfter(T.pen);
  return (
    <span className="td-circled">
      {children}
      <svg viewBox="0 0 90 30" className="td-pen" data-on={on ? "" : undefined} preserveAspectRatio="none">
        <path d="M8 15C7 6 40 2 66 4c16 1 22 6 20 12-3 8-30 11-52 10C14 25 3 20 6 12 9 6 26 3 44 3" pathLength={1} />
      </svg>
    </span>
  );
}

/** Body text around the passage, drawn as ink bars: there to be skimmed past, not read. */
function Greek({ widths }: { widths: number[] }) {
  return (
    <span className="td-greek">
      {widths.map((w, k) => (
        <i key={k} style={{ width: `${w}%` }} />
      ))}
    </span>
  );
}

/** One row of a printed table; `mark` highlights it with the passage. */
function Row({ cells, kind, mark, delay = 0 }: { cells: ReactNode[]; kind?: "head" | "total"; mark?: boolean; delay?: number }) {
  const on = useAfter(mark ? T.mark + delay : Infinity);
  return (
    <div className={`td-tr${kind ? ` is-${kind}` : ""}`} data-on={on ? "" : undefined}>
      {cells.map((c, k) => (
        <span key={k}>{c}</span>
      ))}
    </div>
  );
}

// ───────────── teams ─────────────

const TEAMS: Team[] = [
  {
    id: "legal",
    name: "Legal",
    word: "legal",
    files: [
      { ext: "pdf", name: "Acme services agreement" },
      { ext: "docx", name: "NDA template" },
      { ext: "pdf", name: "Privacy policy" },
    ],
    question: "How much notice do we need to end the Acme contract?",
    answer: "90 days in writing, sent to the legal contact named in the agreement",
    source: { ext: "pdf", name: "Acme services agreement", where: "p. 12" },
    doc: {
      kicker: "ACME CORP.",
      title: "SERVICES AGREEMENT",
      no: "12",
      body: (
        <>
          <p className="td-d-h">12. Term and termination</p>
          <p className="td-d-p">
            <b>12.1</b> This Agreement runs for two years and renews for one year at a time, unless it is ended as set out below.
          </p>
          <p className="td-d-p">
            <b>12.2</b>{" "}
            <Mark>
              Either party may end this Agreement by giving <Circle>ninety (90) days&rsquo;</Circle> written notice to the legal contact named in Schedule A.
            </Mark>
          </p>
          <Greek widths={[100, 96, 88, 100, 62]} />
        </>
      ),
      foot: (
        <>
          <span>MSA-2024-118</span>
          <span>Page 12 of 18</span>
        </>
      ),
    },
  },
  {
    id: "hr",
    name: "HR",
    word: "HR",
    files: [
      { ext: "pdf", name: "Employee handbook" },
      { ext: "xlsx", name: "Benefits 2026" },
      { ext: "docx", name: "Onboarding checklist" },
    ],
    question: "How many vacation days does a new hire get?",
    answer: "15 days in the first year, rising to 20 after two years of service",
    source: { ext: "pdf", name: "Employee handbook", where: "p. 8" },
    doc: {
      kicker: "PEOPLE TEAM",
      title: "EMPLOYEE HANDBOOK",
      no: "8",
      body: (
        <>
          <p className="td-d-h">4. Time off</p>
          <p className="td-d-p">Paid vacation grows with years of service. Unused days carry over until March.</p>
          <div className="td-table" data-cols="2">
            <Row kind="head" cells={["Years of service", "Vacation days"]} />
            <Row mark cells={["First year", <Circle key="c">15 days</Circle>]} />
            <Row mark delay={160} cells={["After 2 years", "20 days"]} />
            <Row cells={["After 5 years", "25 days"]} />
          </div>
          <Greek widths={[100, 92, 70]} />
        </>
      ),
      foot: (
        <>
          <span>HB-2026</span>
          <span>Page 8 of 40</span>
        </>
      ),
    },
  },
  {
    id: "finance",
    name: "Finance",
    word: "finance",
    files: [
      { ext: "xlsx", name: "Q3 spend report" },
      { ext: "pdf", name: "Annual budget" },
      { ext: "pptx", name: "Board update" },
    ],
    question: "Did marketing stay within budget in Q3?",
    answer: "Yes: $412k spent against a $450k budget, about 8% under",
    source: { ext: "xlsx", name: "Q3 spend report", where: "sheet Spend" },
    doc: {
      kicker: "FINANCE · FY2026",
      title: "Q3 SPEND REPORT",
      no: "Q3",
      body: (
        <>
          <p className="td-d-h">Spend by team, July to September</p>
          <div className="td-table" data-cols="4">
            <Row kind="head" cells={["Team", "Budget", "Spent", "Var."]} />
            <Row cells={["Sales", "$620k", "$648k", "+4.5%"]} />
            <Row mark cells={["Marketing", "$450k", <Circle key="c">$412k</Circle>, "−8.4%"]} />
            <Row cells={["Product", "$380k", "$371k", "−2.4%"]} />
            <Row cells={["Support", "$210k", "$226k", "+7.6%"]} />
            <Row kind="total" cells={["Total", "$1.66M", "$1.66M", "−0.2%"]} />
          </div>
        </>
      ),
      foot: (
        <span className="td-p-tabs">
          <span>Summary</span>
          <span data-on="">Spend</span>
          <span>Notes</span>
        </span>
      ),
    },
  },
  {
    id: "ops",
    name: "Operations",
    word: "operations",
    files: [
      { ext: "docx", name: "Returns procedure" },
      { ext: "pdf", name: "Warehouse manual" },
      { ext: "pdf", name: "Carrier contract" },
    ],
    question: "What do we do when an order arrives damaged?",
    answer: "Send a replacement within 48 hours and log the case as a carrier claim",
    source: { ext: "docx", name: "Returns procedure", where: "§3.2" },
    doc: {
      kicker: "OPERATIONS",
      title: "RETURNS PROCEDURE",
      no: "3.2",
      body: (
        <>
          <p className="td-d-h">3.2 Damaged on arrival</p>
          <ol className="td-d-list">
            <li>Ask the customer for a photo of the box and the item.</li>
            <li>
              <Mark>
                Send a replacement within <Circle>48 hours</Circle> of the photo.
              </Mark>
            </li>
            <li>
              <Mark delay={220}>Log the case as a carrier claim in the returns sheet.</Mark>
            </li>
            <li>
              <Greek widths={[100, 74]} />
            </li>
          </ol>
          <Greek widths={[96, 100, 58]} />
        </>
      ),
      foot: (
        <>
          <span>Rev. 4 · Operations</span>
          <span>Page 3 of 9</span>
        </>
      ),
    },
  },
];

// ───────────── shell ─────────────

export function TeamDemo() {
  const [index, setIndex] = useState(0);
  const [lap, setLap] = useState(0); // bumps on every new team, so its story mounts clean
  const [still, setStill] = useState(false);
  const clock = useRef<Clock>(null as unknown as Clock);
  if (!clock.current) clock.current = makeClock();
  const root = useRef<HTMLDivElement>(null);
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
      const dt = Math.min(64, now - last); // a dropped frame or a sleeping tab never skips a beat
      last = now;
      const h = hold.current;
      const paused = h.offscreen || h.hidden;
      // CSS animations (beam, pen, shimmer) pause with the clock so they never drift from it.
      if (root.current && root.current.hasAttribute("data-paused") !== paused) root.current.toggleAttribute("data-paused", paused);
      if (!paused) {
        // Someone reading: let the answer finish, then wait on it.
        const next = Math.min(c.t + dt, h.hover ? T.leave - 1 : Infinity);
        if (next >= T.end) {
          c.t = 0;
          setIndex((i) => (i + 1) % TEAMS.length);
          setLap((n) => n + 1);
        } else if (next !== c.t) {
          c.t = next;
          c.emit();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [still]);

  // The new team's story reads the reset clock as it mounts; the heading catches up here.
  useEffect(() => {
    clock.current.emit();
  }, [lap]);

  const team = TEAMS[index]!;

  return (
    <ClockContext.Provider value={clock.current}>
      <h2 className="td-title">
        <span className="sr-only">Your files answer your team, with the source.</span>
        <span aria-hidden="true">
          Your files answer your
          <br />
          <em>
            <TeamWord index={index} />
          </em>{" "}
          team, with the <em>source</em>.
        </span>
      </h2>

      <div ref={root} className="gate-title td" data-still={still ? "" : undefined}>
        <i className="gate-beam" data-line="top" aria-hidden="true" />
        <i className="gate-beam" data-line="bottom" aria-hidden="true" />
        <i className="gate-x" data-at="tl" aria-hidden="true" />
        <i className="gate-x" data-at="tr" aria-hidden="true" />
        <i className="gate-x" data-at="bl" aria-hidden="true" />
        <i className="gate-x" data-at="br" aria-hidden="true" />

        <figure
          className="td-stage"
          aria-label={`${team.name}: ${team.question} ${team.answer}. Source: ${team.source.name}, ${team.source.where}.`}
          onPointerEnter={(e) => {
            if (e.pointerType === "mouse") hold.current.hover = true;
          }}
          onPointerLeave={() => {
            hold.current.hover = false;
          }}
        >
          <Story key={`${team.id}-${lap}`} team={team} />
        </figure>
      </div>
    </ClockContext.Provider>
  );
}

/**
 * The team named in the heading. It changes as the current story fades out, letter by letter: the
 * old word lifts away blurred while the new one settles in, and the gap it sits in eases to the new
 * width so the rest of the line glides instead of jumping.
 */
function TeamWord({ index }: { index: number }) {
  const upcoming = useAfter(T.leave);
  const word = TEAMS[upcoming ? (index + 1) % TEAMS.length : index]!.word;
  const [prev, setPrev] = useState<string | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  const last = useRef(word);
  const cur = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (last.current === word) return;
    setPrev(last.current);
    last.current = word;
    const t = setTimeout(() => setPrev(null), 700);
    return () => clearTimeout(t);
  }, [word]);

  // Track the word's own width (it also changes when the brand font finishes loading).
  useLayoutEffect(() => {
    const el = cur.current;
    if (!el) return;
    setWidth(el.offsetWidth);
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, [word]);

  const letters = (w: string) => [...w].map((ch, k) => <span key={k} style={{ ["--i" as string]: k }}>{ch}</span>);

  return (
    <span className="td-word" style={width === null ? undefined : { width }}>
      {prev && (
        <span key={`out-${prev}`} className="td-word-in is-exit">
          {letters(prev)}
        </span>
      )}
      <span key={word} ref={cur} className="td-word-in">
        {letters(word)}
      </span>
    </span>
  );
}

function Story({ team }: { team: Team }) {
  const leaving = useAfter(T.leave);
  return (
    <div className="td-story" data-leaving={leaving ? "" : undefined} aria-hidden="true">
      <Desk team={team} />
      <div className="td-side">
        <Narration team={team} />
        <Question text={team.question} />
        <Panel team={team} />
      </div>
    </div>
  );
}

// ───────────── the desk: the team's files, the source on top ─────────────

function Desk({ team }: { team: Team }) {
  const state = useClockValue((t) => (t >= T.found ? "found" : t >= T.search ? "search" : "idle"));
  const others = team.files.filter((f) => f.name !== team.source.name);
  return (
    <div className="td-desk" data-state={state}>
      {others.map((f, k) => (
        <div key={f.name} className={`td-sheet ${typewriter.variable}`} data-k={k}>
          <span className="td-sheet-title">{f.name}</span>
          <Greek widths={[92, 100, 78, 100, 96, 54]} />
        </div>
      ))}
      <Paper doc={team.doc} />
    </div>
  );
}

/** The scan beam: the sweep is a CSS transform animation (compositor only); the clock only says when it runs. */
function Beam() {
  const on = useClockValue((t) => t >= T.scan[0] && t < T.scan[1] + 240);
  return <span className="td-beam" data-on={on ? "" : undefined} style={{ ["--scan" as string]: `${T.scan[1] - T.scan[0]}ms` }} />;
}

function Paper({ doc }: { doc: Team["doc"] }) {
  return (
    <div className={`td-paper ${typewriter.variable}`}>
      <Beam />
      <div className="td-p-head">
        <span className="td-p-brand">
          <span>{doc.kicker}</span>
          <strong>{doc.title}</strong>
        </span>
        <span className="td-p-no">{doc.no}</span>
      </div>
      <div className="td-p-body">{doc.body}</div>
      <div className="td-p-foot">{doc.foot}</div>
    </div>
  );
}

// ───────────── what Ragis is doing ─────────────

function Narration({ team }: { team: Team }) {
  const lines: { at: number; text: string; state: "idle" | "busy" | "done" }[] = [
    { at: 0, text: `${team.name} workspace`, state: "idle" },
    { at: T.search, text: `Searching ${team.files.length} files`, state: "busy" },
    { at: T.found, text: `Reading ${team.source.where}`, state: "busy" },
    { at: T.answer, text: "Writing the answer", state: "busy" },
    { at: T.verified, text: `Checked against ${team.source.where}`, state: "done" },
  ];
  const i = useClockValue((t) => lines.reduce((acc, l, k) => (t >= l.at ? k : acc), 0));
  const line = lines[i]!;
  return (
    <div className="td-narr">
      <span className="td-narr-mark" data-state={line.state}>
        <LogoMark size={11} />
      </span>
      <span key={i} className="td-narr-text" data-state={line.state} data-text={line.text}>
        {line.text}
      </span>
    </div>
  );
}

function Question({ text }: { text: string }) {
  const shown = useAfter(T.type[0] - 150);
  const typed = useProgress(T.type[0], T.type[1], text.length);
  return (
    <p className="td-q" data-on={shown ? "" : undefined} data-typing={typed < text.length ? "" : undefined}>
      {text.slice(0, typed)}
      <span className="td-q-ghost">{text.slice(typed)}</span>
    </p>
  );
}

/** One step at a time: the file search, then the cited answer. The outgoing one lifts away as the next settles in. */
function Panel({ team }: { team: Team }) {
  const i = useClockValue((t) => (t >= T.answer ? 2 : t >= T.search ? 1 : 0));
  const [prev, setPrev] = useState<number | null>(null);
  const last = useRef(i);
  useEffect(() => {
    if (last.current === i) return;
    setPrev(last.current);
    last.current = i;
    const t = setTimeout(() => setPrev(null), 360);
    return () => clearTimeout(t);
  }, [i]);
  const view = (k: number) => (k === 1 ? <Search team={team} /> : k === 2 ? <Answer team={team} /> : null);
  return (
    <div className="td-panel">
      {prev ? (
        <div key={`p${prev}`} className="td-phase is-exit">
          {view(prev)}
        </div>
      ) : null}
      {i > 0 && (
        <div key={`c${i}`} className="td-phase">
          {view(i)}
        </div>
      )}
    </div>
  );
}

function Search({ team }: { team: Team }) {
  const found = useAfter(T.found);
  return (
    <ul className="td-hits" data-found={found ? "" : undefined}>
      {team.files.map((f, k) => {
        const match = f.name === team.source.name;
        return (
          <In key={f.name} at={T.search + 60 + k * 110} as="li" className={`td-rise td-hit${found ? (match ? " is-match" : " is-miss") : ""}`} style={{ ["--k" as string]: k }}>
            <FileTile ext={f.ext} size={16} />
            <span className="td-hit-name">{f.name}</span>
            {match && <span className="td-hit-where">{team.source.where}</span>}
          </In>
        );
      })}
    </ul>
  );
}

function Answer({ team }: { team: Team }) {
  const on = useAfter(T.answer + 100);
  const words = team.answer.split(" ");
  const last = words.length - 1;
  const word = (k: number) => (
    <span className="td-w" style={{ transitionDelay: `${k * 45}ms` }}>
      {words[k]}
    </span>
  );
  const end = { transitionDelay: `${words.length * 45}ms` };
  return (
    <div className="td-ask">
      <p className={`td-answer${on ? " is-in" : ""}`}>
        {words.slice(0, last).map((_, k) => (
          <span key={k}>
            {word(k)}{" "}
          </span>
        ))}
        {/* the last word, the citation and the period wrap as one, so the citation never sits alone on a line */}
        <span className="td-answer-end">
          {word(last)}
          <span className="td-w td-cite" style={end}>
            1
          </span>
          <span className="td-w" style={end}>
            .
          </span>
        </span>
      </p>
      <div className="td-sources">
        <In at={T.source} as="span" className="td-rise td-src">
          <span className="td-src-n">1</span>
          <FileTile ext={team.source.ext} size={16} />
          <span className="td-src-name">{team.source.name}</span>
          <span className="td-src-loc">{team.source.where}</span>
        </In>
        <In at={T.verified} as="span" className="td-rise td-verified">
          <i className="td-dot" aria-hidden="true" />
          Verified
        </In>
      </div>
    </div>
  );
}
