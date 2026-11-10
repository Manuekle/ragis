"use client";

import { animate, motion, useMotionValue, useReducedMotion, type AnimationPlaybackControls } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { IconArrowRight } from "@/components/icons";

type View = "hero" | "more";

// The swap is instant; the incoming page only settles into place from a short offset, with no fading
// or blur. A quick spring (response 0.2s, damping 1: it never overshoots) so it can be pressed again
// at any moment and carries its speed (fluid-interactions).
const RESPONSE = 0.2;
const SPRING = { type: "spring" as const, stiffness: Math.pow((2 * Math.PI) / RESPONSE, 2), damping: (4 * Math.PI) / RESPONSE, mass: 1, restDelta: 0.5, restSpeed: 20 };
const DISTANCE = 16; // px the incoming page starts away from its place
const WHEEL_GAP = 160; // ms of quiet that separates two wheel gestures
const WHEEL_TRAVEL = 40; // px of downward wheel that counts as "scroll down"

/**
 * The landing is two views, never one long scroll. The hero fits one screen; the floating button
 * (or a downward wheel) swaps it for the content view and then swaps back, so there is no scrolling
 * up past the content into the hero. Both views stay in the DOM (hidden at rest) for crawlers.
 */
export function LandingViews({ hero, more }: { hero: ReactNode; more: ReactNode }) {
  const reduceMotion = useReducedMotion() ?? false;
  const slide = useMotionValue(0);
  const [view, setView] = useState<View>("hero");
  const viewRef = useRef<View>("hero");
  const run = useRef<AnimationPlaybackControls | undefined>(undefined);

  const go = useCallback(
    (next: View) => {
      if (viewRef.current === next) return;
      viewRef.current = next;
      setView(next);

      try {
        window.history.replaceState(window.history.state, "", next === "more" ? "#how" : window.location.pathname + window.location.search);
      } catch {
        // history can be locked down in embedded browsers; the swap still works
      }

      // Going to the content the page rises into place; going back it drops into place.
      run.current?.stop();
      if (reduceMotion) {
        slide.set(0);
        return;
      }
      slide.set(next === "more" ? DISTANCE : -DISTANCE);
      run.current = animate(slide, 0, SPRING);
    },
    [reduceMotion, slide],
  );

  // Each view starts at the top.
  useLayoutEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  // A link to /#how opens the content view directly.
  useEffect(() => {
    if (window.location.hash === "#how") {
      viewRef.current = "more";
      setView("more");
    }
  }, []);

  // Scrolling down on the hero asks for the same thing as the button. Only a wheel gesture that
  // began while the hero was showing counts: a trackpad keeps sending momentum for about a second,
  // and that tail from scrolling the content must not bounce the reader straight back in.
  useEffect(() => {
    let last = 0;
    let armed = false;
    let travel = 0;
    const onWheel = (event: WheelEvent) => {
      const now = performance.now();
      if (now - last > WHEEL_GAP) {
        armed = viewRef.current === "hero";
        travel = 0;
      }
      last = now;
      if (!armed) return;
      travel += event.deltaY;
      if (travel > WHEEL_TRAVEL) {
        armed = false;
        go("more");
      }
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => window.removeEventListener("wheel", onWheel);
  }, [go]);

  useEffect(() => () => run.current?.stop(), []);

  return (
    <>
      <div className="land-views">
        <motion.div className="land-view" data-view="hero" hidden={view !== "hero"} style={{ y: slide }}>
          {hero}
        </motion.div>
        <motion.div className="land-view" data-view="more" hidden={view !== "more"} style={{ y: slide }}>
          {more}
        </motion.div>
      </div>

      <button type="button" className="land-scroll" data-view={view} aria-label={view === "hero" ? "See how it works" : "Back to start"} onClick={() => go(view === "hero" ? "more" : "hero")}>
        <span className="land-scroll-label" data-for="hero" aria-hidden="true">
          See how it works
          <IconArrowRight size={13} className="land-scroll-ico" />
        </span>
        <span className="land-scroll-label" data-for="more" aria-hidden="true">
          <IconArrowRight size={13} className="land-scroll-ico" />
          Back to start
        </span>
      </button>
    </>
  );
}
