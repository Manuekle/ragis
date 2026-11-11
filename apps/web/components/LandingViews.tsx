"use client";

import { animate, motion, useMotionValue, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** In reading order: hero, then what Ragis is, then the people backing it. */
const VIEWS = ["hero", "more", "wall"] as const;
type View = (typeof VIEWS)[number];

/** The URL hash that opens each view directly. */
const HASH: Record<View, string> = { hero: "", more: "#how", wall: "#backers" };

// Changing view is a page turn you can see: the page leaves toward where you are scrolling (up and
// out going forward, down and out going back), then the next one rises (or drops) into place from
// further away and settles on a spring with no overshoot. Opacity, translate and scale only: the
// views carry live dither canvases, and a blur would repaint them every frame.
const EXIT_Y = 56; // px
const ENTER_Y = 88; // px
const EXIT_SCALE = 0.985;
const EXIT = { duration: 0.2, ease: [0.4, 0, 1, 1] as const };
const EXIT_FADE = { duration: 0.18, ease: "easeIn" as const };
const ENTER_FADE = { duration: 0.32, ease: "easeOut" as const };
const RESPONSE = 0.42; // s
const SPRING = { type: "spring" as const, stiffness: Math.pow((2 * Math.PI) / RESPONSE, 2), damping: (4 * Math.PI) / RESPONSE, mass: 1, restDelta: 0.5, restSpeed: 10 };

// Scrolling past either end of a view turns the page, like the buttons. Only a gesture that began at
// that end counts: a trackpad keeps sending momentum for about a second, and the tail of reading to
// the end (or of the turn itself) must not carry the reader straight on to the next view.
const WHEEL_GAP = 160; // ms of quiet that separates two wheel gestures
const WHEEL_TRAVEL_HERO = 40; // px of wheel on the one-screen hero
const WHEEL_TRAVEL = 100; // px past the end of a view that scrolls
const TOUCH_PULL = 90; // px a finger drags past the end
const EDGE_SLACK = 4; // px from the top or bottom that still counts as "at the end"

const atTop = () => window.scrollY <= EDGE_SLACK;
const atEnd = () => window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - EDGE_SLACK;
const prevOf = (v: View): View | null => VIEWS[VIEWS.indexOf(v) - 1] ?? null;
const nextOf = (v: View): View | null => VIEWS[VIEWS.indexOf(v) + 1] ?? null;

/**
 * The landing is three views, never one long scroll. The hero fits one screen; a floating pill at
 * the bottom moves on ("See how it works", "Backers"), one at the top steps back ("Start",
 * "Back"), and scrolling past either end does the same. Going back lands at the end of the previous
 * view, so the reading carries on where it left off. All three stay in the DOM (hidden at rest) for
 * crawlers.
 */
export function LandingViews({ hero, more, wall }: { hero: ReactNode; more: ReactNode; wall: ReactNode }) {
  const reduceMotion = useReducedMotion() ?? false;
  const y = useMotionValue(0);
  const opacity = useMotionValue(1);
  const scale = useMotionValue(1);
  const [view, setView] = useState<View>("hero");
  const viewRef = useRef<View>("hero");
  // Set while a page turn runs, so a second press or the rest of a flick can't start another.
  const busy = useRef(false);
  // The turn that just swapped the view: which way it went, and where the new view should open.
  const turn = useRef<{ dir: 1 | -1; land: "top" | "end" } | null>(null);
  const runs = useRef<AnimationPlaybackControls[]>([]);

  const go = useCallback(
    (next: View) => {
      const from = viewRef.current;
      if (from === next || busy.current) return;
      busy.current = true;
      viewRef.current = next;
      const dir = VIEWS.indexOf(next) > VIEWS.indexOf(from) ? 1 : -1;

      try {
        window.history.replaceState(window.history.state, "", HASH[next] || window.location.pathname + window.location.search);
      } catch {
        // history can be locked down in embedded browsers; the turn still works
      }

      const swap = () => {
        turn.current = { dir, land: dir > 0 ? "top" : "end" };
        setView(next);
      };
      runs.current.forEach((run) => run.stop());
      if (reduceMotion) {
        swap();
        return;
      }
      runs.current = [animate(y, -dir * EXIT_Y, EXIT), animate(scale, EXIT_SCALE, EXIT), animate(opacity, 0, EXIT_FADE)];
      Promise.all(runs.current.map((run) => run.finished)).then(swap, swap);
    },
    [reduceMotion, y, scale, opacity],
  );

  // The new view is in the DOM: put the page where it should open, then bring it in.
  useLayoutEffect(() => {
    const done = turn.current;
    turn.current = null;
    window.scrollTo(0, done?.land === "end" ? document.documentElement.scrollHeight : 0);
    if (!done) return;
    if (reduceMotion) {
      y.set(0);
      scale.set(1);
      opacity.set(0);
      animate(opacity, 1, { duration: 0.15 }).finished.then(() => (busy.current = false));
      return;
    }
    y.set(done.dir * ENTER_Y);
    scale.set(EXIT_SCALE);
    const fade = animate(opacity, 1, ENTER_FADE);
    runs.current = [animate(y, 0, SPRING), animate(scale, 1, SPRING), fade];
    // Free to turn again once the page is fully visible; the spring can finish settling under a new turn.
    fade.finished.then(() => (busy.current = false));
  }, [view, reduceMotion, y, scale, opacity]);

  // A link to /#how or /#backers opens that view directly.
  useEffect(() => {
    const linked = VIEWS.find((v) => HASH[v] && HASH[v] === window.location.hash);
    if (linked) {
      viewRef.current = linked;
      setView(linked);
    }
  }, []);

  // Wheel past either end.
  useEffect(() => {
    let last = 0;
    let up: View | null = null;
    let down: View | null = null;
    let need = WHEEL_TRAVEL;
    let travel = 0;
    const onWheel = (event: WheelEvent) => {
      const now = performance.now();
      if (now - last > WHEEL_GAP) {
        const v = viewRef.current;
        up = !busy.current && atTop() ? prevOf(v) : null;
        down = !busy.current && atEnd() ? nextOf(v) : null;
        need = v === "hero" ? WHEEL_TRAVEL_HERO : WHEEL_TRAVEL;
        travel = 0;
      }
      last = now;
      if (!up && !down) return;
      travel += event.deltaY;
      const target = travel > need ? down : travel < -need ? up : null;
      if (target) {
        up = down = null;
        go(target);
      }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [go]);

  // The same with a finger: a drag that starts at an end and keeps pulling past it.
  useEffect(() => {
    let startY = 0;
    let up: View | null = null;
    let down: View | null = null;
    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || busy.current) {
        up = down = null;
        return;
      }
      startY = event.touches[0].clientY;
      const v = viewRef.current;
      up = atTop() ? prevOf(v) : null;
      down = atEnd() ? nextOf(v) : null;
    };
    const onMove = (event: TouchEvent) => {
      if (!up && !down) return;
      const pulled = event.touches[0].clientY - startY;
      const target = pulled > TOUCH_PULL ? up : pulled < -TOUCH_PULL ? down : null;
      if (target) {
        up = down = null;
        go(target);
      }
    };
    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchmove", onMove, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchmove", onMove);
    };
  }, [go]);

  useEffect(() => () => runs.current.forEach((run) => run.stop()), []);

  const back = prevOf(view);
  const next = nextOf(view);

  return (
    <>
      <motion.div className="land-views" style={{ y, opacity, scale }}>
        {(
          [
            ["hero", hero],
            ["more", more],
            ["wall", wall],
          ] as const
        ).map(([v, node]) => (
          <div key={v} className="land-view" data-view={v} hidden={view !== v}>
            {node}
          </div>
        ))}
      </motion.div>

      {/* Back, at the top. A pill's labels share one cell so it keeps its size while they swap. */}
      <button
        type="button"
        className="land-scroll"
        data-edge="top"
        data-view={view}
        data-shown={back ? "" : undefined}
        tabIndex={back ? undefined : -1}
        aria-hidden={back ? undefined : true}
        aria-label={view === "wall" ? "Back to how it works" : "Back to start"}
        onClick={() => back && go(back)}
      >
        <span className="land-scroll-label" data-for="more" aria-hidden="true">
          Start
        </span>
        <span className="land-scroll-label" data-for="wall" aria-hidden="true">
          Back
        </span>
      </button>

      {/* Onward, at the bottom; the wall is the last view, so it has none. */}
      <button
        type="button"
        className="land-scroll"
        data-edge="bottom"
        data-view={view}
        data-shown={next ? "" : undefined}
        tabIndex={next ? undefined : -1}
        aria-hidden={next ? undefined : true}
        aria-label={view === "hero" ? "See how it works" : "Backers"}
        onClick={() => next && go(next)}
      >
        <span className="land-scroll-label" data-for="hero" aria-hidden="true">
          See how it works
        </span>
        <span className="land-scroll-label" data-for="more" aria-hidden="true">
          Backers
        </span>
      </button>
    </>
  );
}
