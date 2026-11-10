// Instagram-style confetti: one radial pop of dots, rings, sticks and squiggles
// in the Instagram gradient colours, plus a pop sound. It is imperative and
// draws on its own canvas under <body>, so a burst fired right before
// router.push keeps falling on the next page.

/** Instagram gradient stops: yellow, orange, pink, magenta, purple. */
const COLORS = ["#FFD600", "#FF7A00", "#FF0069", "#D300C5", "#7638FA"] as const;

type Kind = "dot" | "ring" | "stick" | "squiggle";
// Mix read off Instagram's notes burst: mostly dots and squiggles, some sticks and rings.
const KINDS: readonly (readonly [Kind, number])[] = [
  ["dot", 0.3],
  ["squiggle", 0.3],
  ["stick", 0.22],
  ["ring", 0.18],
];

const GRAVITY = 1100; // px/s²; with drag ≈3 pieces settle near 360 px/s
const BIG_CHANCE = 0.03; // the odd oversized blob or bar
const POP_MS = 160; // pieces grow from 35% to full size as they leave the origin
const FADE_FROM = 0.7; // share of life spent fully opaque

const SOUND_AAC = "/sounds/confetti-pop.m4a";
const SOUND_WAV = "/sounds/confetti-pop.wav";
const SOUND_OFFSET = 0.12; // s of leading silence skipped so the pop lands with the burst
const SOUND_VOLUME = 0.55;
const SOUND_MAX_LAG_MS = 350; // a pop that arrives later than this feels unrelated, so skip it

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  drag: number;
  angle: number;
  spin: number;
  tilt: number; // flip around the piece's own axis, drawn as cos(tilt) on the y scale
  tiltSpeed: number;
  sway: number;
  swayPhase: number;
  swaySpeed: number;
  path: Path2D;
  line: number; // 0 fills the path, otherwise stroke width
  color: string;
  age: number;
  life: number;
}

export interface ConfettiOptions {
  /** Where the burst starts: an element's centre or a viewport point. Defaults to the viewport centre. */
  origin?: Element | { x: number; y: number } | null;
  /** Number of pieces. Defaults to a count scaled to the viewport. */
  count?: number;
  /** Play the pop sound. Defaults to true. */
  sound?: boolean;
}

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const pick = <T,>(items: readonly T[]) => items[Math.floor(Math.random() * items.length)];

function pickKind(): Kind {
  let r = Math.random();
  for (const [kind, weight] of KINDS) if ((r -= weight) <= 0) return kind;
  return "dot";
}

function shape(kind: Kind, big: boolean): { path: Path2D; line: number } {
  const path = new Path2D();
  const scale = big ? rand(2.4, 3) : 1;
  switch (kind) {
    case "dot":
      path.arc(0, 0, big ? rand(10, 15) : rand(3, 6), 0, Math.PI * 2);
      return { path, line: 0 };
    case "ring":
      path.arc(0, 0, rand(4.5, 7), 0, Math.PI * 2);
      return { path, line: 2.25 };
    case "stick": {
      const half = rand(5, 10) * scale;
      path.moveTo(-half, 0);
      path.lineTo(half, 0);
      return { path, line: rand(3, 4) * scale };
    }
    case "squiggle": {
      // A zigzag with its corners rounded off by quadratic curves through the midpoints.
      const seg = rand(4.5, 6) * scale;
      const amp = rand(2.5, 3.5) * scale;
      const n = Math.random() < 0.5 ? 3 : 4;
      const pts = Array.from({ length: n + 1 }, (_, i) => [i * seg - (n * seg) / 2, i % 2 ? amp : -amp] as const);
      path.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < n; i++) {
        const [cx, cy] = pts[i];
        const [nx, ny] = pts[i + 1];
        path.quadraticCurveTo(cx, cy, (cx + nx) / 2, (cy + ny) / 2);
      }
      path.lineTo(pts[n][0], pts[n][1]);
      return { path, line: rand(2.75, 3.5) * (big ? 2.8 : 1) };
    }
  }
}

/* ───────────── canvas + loop ───────────── */

let canvas: HTMLCanvasElement | null = null;
let ctx: CanvasRenderingContext2D | null = null;
let dpr = 1;
let pieces: Piece[] = [];
let raf = 0;
let last = 0;

function resize() {
  if (!canvas || !ctx) return;
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
}

function mount() {
  if (canvas?.isConnected) return;
  canvas = document.createElement("canvas");
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;z-index:9999";
  ctx = canvas.getContext("2d");
  document.body.appendChild(canvas);
  resize();
  window.addEventListener("resize", resize);
}

function unmount() {
  window.removeEventListener("resize", resize);
  canvas?.remove();
  canvas = null;
  ctx = null;
}

function frame(now: number) {
  if (!canvas || !ctx) return;
  const dt = Math.min((now - last) / 1000, 1 / 30); // a hidden tab or a long frame never teleports pieces
  last = now;
  const h = window.innerHeight;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  pieces = pieces.filter((p) => {
    const decay = Math.exp(-p.drag * dt);
    p.vx *= decay;
    p.vy = p.vy * decay + GRAVITY * dt;
    p.swayPhase += p.swaySpeed * dt;
    p.x += (p.vx + Math.sin(p.swayPhase) * p.sway) * dt;
    p.y += p.vy * dt;
    p.angle += p.spin * dt;
    p.tilt += p.tiltSpeed * dt;
    p.age += dt;
    if (p.age >= p.life || p.y > h + 80) return false;

    const t = p.age / p.life;
    const grow = Math.min(1, (p.age * 1000) / POP_MS);
    const s = (0.35 + 0.65 * (1 - (1 - grow) ** 3)) * dpr;
    const c = Math.cos(p.tilt);
    const flip = Math.sign(c || 1) * Math.max(Math.abs(c), 0.35); // never edge-on hairlines
    const cos = Math.cos(p.angle);
    const sin = Math.sin(p.angle);
    ctx!.globalAlpha = t < FADE_FROM ? 1 : 1 - (t - FADE_FROM) / (1 - FADE_FROM);
    ctx!.setTransform(cos * s, sin * s, -sin * s * flip, cos * s * flip, p.x * dpr, p.y * dpr);
    if (p.line) {
      ctx!.lineWidth = p.line;
      ctx!.strokeStyle = p.color;
      ctx!.stroke(p.path);
    } else {
      ctx!.fillStyle = p.color;
      ctx!.fill(p.path);
    }
    return true;
  });

  if (pieces.length) raf = requestAnimationFrame(frame);
  else {
    raf = 0;
    unmount();
  }
}

function burst(x: number, y: number, count: number) {
  const reach = Math.hypot(window.innerWidth, window.innerHeight) * 0.5;
  for (let i = 0; i < count; i++) {
    const kind = pickKind();
    const big = kind !== "ring" && Math.random() < BIG_CHANCE;
    const { path, line } = shape(kind, big);
    const drag = rand(2.6, 3.6) * (big ? 0.85 : 1);
    const dir = Math.random() * Math.PI * 2;
    // Distance travelled before drag stops a piece is speed / drag, so this spreads
    // pieces across the reach, denser towards the rim like a real pop.
    const speed = reach * drag * (0.2 + 0.8 * Math.sqrt(Math.random()));
    const flat = kind !== "dot";
    pieces.push({
      x,
      y,
      vx: Math.cos(dir) * speed,
      vy: Math.sin(dir) * speed - reach * drag * 0.22,
      drag,
      angle: Math.random() * Math.PI * 2,
      spin: rand(-6, 6),
      tilt: flat ? Math.random() * Math.PI * 2 : 0,
      tiltSpeed: flat ? rand(4, 10) * (Math.random() < 0.5 ? -1 : 1) : 0,
      sway: flat ? rand(15, 55) : 0,
      swayPhase: Math.random() * Math.PI * 2,
      swaySpeed: rand(2, 4.5),
      path,
      line,
      color: pick(COLORS),
      age: 0,
      life: rand(2.4, 3.4),
    });
  }
}

/* ───────────── sound ───────────── */

let audio: AudioContext | null = null;
let buffer: Promise<AudioBuffer | null> | null = null;

function audioContext(): AudioContext | null {
  if (audio) return audio;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return AC ? (audio = new AC()) : null;
}

function loadSound(ac: AudioContext) {
  buffer ??= fetch(document.createElement("audio").canPlayType('audio/mp4; codecs="mp4a.40.2"') ? SOUND_AAC : SOUND_WAV)
    .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
    .then((data) => ac.decodeAudioData(data))
    .catch(() => null);
  return buffer;
}

function playPop() {
  const ac = audioContext();
  if (!ac) return;
  if (ac.state === "suspended") void ac.resume().catch(() => {});
  const asked = performance.now();
  void loadSound(ac).then((buf) => {
    if (!buf || performance.now() - asked > SOUND_MAX_LAG_MS) return;
    const src = ac.createBufferSource();
    const gain = ac.createGain();
    src.buffer = buf;
    gain.gain.value = SOUND_VOLUME;
    src.connect(gain).connect(ac.destination);
    src.start(0, SOUND_OFFSET);
  });
}

// Browsers keep audio locked until the user interacts. Unlock it (and fetch the
// sound) on the first gesture, so a pop fired after an awaited request still plays.
if (typeof window !== "undefined") {
  const events = ["pointerdown", "touchend", "click", "keydown"] as const;
  const stop = () => events.forEach((e) => window.removeEventListener(e, unlock, true));
  const unlock = () => {
    const ac = audioContext();
    if (!ac) return stop();
    void loadSound(ac);
    if (ac.state === "running") return stop();
    ac.resume().then(() => ac.state === "running" && stop(), () => {});
  };
  events.forEach((e) => window.addEventListener(e, unlock, { capture: true, passive: true }));
}

/* ───────────── public API ───────────── */

function originPoint(origin: ConfettiOptions["origin"]): { x: number; y: number } {
  if (origin && "getBoundingClientRect" in origin) {
    const r = origin.getBoundingClientRect();
    if (r.width || r.height) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  } else if (origin) return origin;
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/** Fire one Instagram-style confetti pop. Reduced motion keeps the sound and drops the pieces. */
export function confetti({ origin, count, sound = true }: ConfettiOptions = {}) {
  if (typeof window === "undefined") return;
  if (sound) playPop();
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const { x, y } = originPoint(origin);
  const n = count ?? Math.round(Math.min(160, Math.max(70, (window.innerWidth * window.innerHeight) / 8000)));
  mount();
  burst(x, y, n);
  if (!raf) {
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
}
