export type Point = { x: number; y: number };

// How fast the pointer is moving when you let go, in px/s. The browser only
// gives positions, so this keeps the last 100ms of them and measures across
// that window. Earlier movement doesn't matter: a slow drag that ends in a
// flick should report the flick, not the average.
export class VelocityTracker {
  private samples: { t: number; x: number; y: number }[] = [];

  reset() {
    this.samples = [];
  }

  add(x: number, y: number) {
    const t = performance.now();
    this.samples.push({ t, x, y });
    this.samples = this.samples.filter((s) => t - s.t < 100);
  }

  get(): Point {
    const now = performance.now();
    // A finger held still sends no events, so old samples are dropped here too
    const recent = this.samples.filter((s) => now - s.t < 100);
    if (recent.length < 2) return { x: 0, y: 0 };
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt === 0) return { x: 0, y: 0 };
    return { x: (last.x - first.x) / dt, y: (last.y - first.y) / dt };
  }
}

const RUBBER_BAND_C = 0.55;

// How far something moves when pulled x px past its edge. d is the size of
// the container on that axis: the offset approaches d but never reaches it.
export const rubberBand = (x: number, d: number, c = RUBBER_BAND_C) =>
  (1 - 1 / ((c * x) / d + 1)) * d;

// The pull needed to reach a given offset. Use it to pick up a stretch
// mid-bounce without a jump.
export const rubberBandInverse = (
  offset: number,
  d: number,
  c = RUBBER_BAND_C,
) => (offset >= d ? Infinity : (offset * d) / (c * (d - offset)));

// Passes value through between min and max, rubber bands outside them
export const applyRubberBand = (
  value: number,
  min: number,
  max: number,
  d: number,
  c = RUBBER_BAND_C,
) => {
  if (value < min) return min - rubberBand(min - value, d, c);
  if (value > max) return max + rubberBand(value - max, d, c);
  return value;
};

// Rubber band in either direction from 0, for things with no free range
export const stretch = (delta: number, d: number) =>
  Math.sign(delta) * rubberBand(Math.abs(delta), d);

// A spring described the way designers think about it: response is roughly
// how long it takes to get there (seconds), dampingRatio is how much it
// bounces (1 = none, lower = more). Returns a motion/react transition.
export const springFromResponse = (
  response: number,
  dampingRatio: number,
  mass = 1,
) => ({
  type: "spring" as const,
  stiffness: Math.pow((2 * Math.PI) / response, 2) * mass,
  damping: (4 * Math.PI * dampingRatio * mass) / response,
  mass,
});

export type Spring = ReturnType<typeof springFromResponse>;

// The same spring with no overshoot: damping raised to critical (2√(k·m)).
// Keeps the response and the velocity handoff, loses only the bounce.
export const noBounce = (spring: Spring): Spring => ({
  ...spring,
  damping: Math.max(
    spring.damping,
    2 * Math.sqrt(spring.stiffness * spring.mass),
  ),
});

// Reduced motion's stand-in for a big movement: a short fade in place
export const FADE = { duration: 0.2, ease: "easeOut" } as const;

export const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

// Fraction of speed kept per millisecond while coasting
export const DECELERATION = { normal: 0.998, fast: 0.99 };

// How far something released at velocity (px/s) would coast before stopping
export const project = (velocity: number, rate = DECELERATION.normal) =>
  ((velocity / 1000) * rate) / (1 - rate);

export const nearest = (value: number, points: number[]) =>
  points.reduce((best, p) =>
    Math.abs(p - value) < Math.abs(best - value) ? p : best,
  );

export const nearestPoint = (point: Point, points: Point[]) => {
  const distance = (p: Point) => Math.hypot(p.x - point.x, p.y - point.y);
  return points.reduce((best, p) => (distance(p) < distance(best) ? p : best));
};
