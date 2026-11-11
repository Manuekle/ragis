// Waitlist badge: what every badge is made of, shared by the 3D badge (browser), the share image
// (server) and the API. Pure functions only, so it runs in both places.
//
// The badge wears the app's own look: its light or dark surface, its blue, its dither. What makes
// each one different is its number, the name and company on it, the company logo (uploaded by the
// owner, or the company's icon when we can find it) and a halftone pattern grown from the badge's
// id, so no two cards carry the same dots.

import { EARLY_ACCESS, SPONSOR_TIERS } from "@/app/(public)/waitlist/sponsors";

export type BadgeTheme = "light" | "dark";

/** A badge as anyone with the link may see it. Never carries the email. */
export type PublicBadge = {
  slug: string;
  number: number;
  name: string;
  company: string;
  /** The look the owner last had on screen; the share image uses it. Null until they open it. */
  theme: BadgeTheme | null;
  /** Tier shown on the card: a sponsor tier once the slot is confirmed, otherwise early access. */
  tier: string;
  /** Same-origin URL of the company logo, or null when there is none (free-mail address, no icon). */
  logoUrl: string | null;
  /** True when the owner uploaded the logo themselves (it can be removed). */
  ownLogo: boolean;
  /**
   * True when the uploaded logo is a solid square picture (an app icon, a mark on its own
   * background): it then fills its tile on the card edge to edge, instead of sitting on a white one.
   */
  logoFill: boolean;
  createdAt: string;
  updatedAt: string;
};

export const NAME_MAX = 40;
export const COMPANY_MAX = 60;

/** Uploaded logos are stored as PNG, at most this big on a side and in bytes. */
export const LOGO_MAX_PX = 512;
export const LOGO_MAX_BYTES = 400 * 1024;

export function isBadgeTheme(value: unknown): value is BadgeTheme {
  return value === "light" || value === "dark";
}

/**
 * The card's colors, taken from the app's tokens (globals.css): its neutral surfaces and text,
 * and its one blue. Nothing else is offered: a badge is either the light app or the dark app.
 */
export type BadgePalette = {
  /** Card surface, top and bottom of a faint vertical gradient. */
  ground: string;
  groundDeep: string;
  text: string;
  muted: string;
  faint: string;
  /** The app's blue, and the shade of it that reads as text on the card. */
  accent: string;
  accentText: string;
  /** Halftone dots, and how strong the blue wash behind them is (0–1). */
  dot: string;
  glow: number;
  guide: string;
  cross: string;
  /** Hairline printed just inside the card's edge. */
  hairline: string;
  /** The card's physical edge in 3D, and how dark the soft shadow behind it is (0–1). */
  rim: string;
  shade: number;
  /** The page behind the card in the share image. */
  page: string;
};

export const BADGE_THEMES: Record<BadgeTheme, BadgePalette> = {
  light: {
    ground: "#fdfdfe",
    groundDeep: "#f2f2f4",
    text: "#18181b",
    muted: "#52525b",
    faint: "#68686f",
    accent: "#0a84ff",
    accentText: "#0068d6",
    dot: "#0a84ff",
    glow: 0.2,
    guide: "rgba(24, 24, 27, 0.13)",
    cross: "rgba(24, 24, 27, 0.36)",
    hairline: "rgba(24, 24, 32, 0.1)",
    rim: "#dcdce1",
    shade: 0.2,
    page: "#eeeef0",
  },
  dark: {
    ground: "#17171b",
    groundDeep: "#0e0e11",
    text: "#ececef",
    muted: "#aeaeb5",
    faint: "#94949d",
    accent: "#0a84ff",
    accentText: "#5eb0ff",
    dot: "#2f97ff",
    glow: 0.42,
    guide: "rgba(236, 236, 240, 0.13)",
    cross: "rgba(236, 236, 240, 0.4)",
    hairline: "rgba(236, 236, 240, 0.12)",
    rim: "#2c2c33",
    shade: 0.55,
    page: "#17171a",
  },
};

/** The lanyard is the app's blue in both looks. */
export const BAND_COLOR = "#0a84ff";

// ── seeds ──

/** FNV-1a: a stable 32-bit number from a string. */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded random generator (mulberry32): the same seed always gives the same sequence. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── color math ──

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** Blend two colors: t = 0 gives `a`, t = 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

/** rgba() string from a hex color and an alpha. */
export function alpha(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// ── pattern ──

export type Dot = { x: number; y: number; r: number };

/**
 * A halftone field grown from the seed. Dot sizes follow three overlapping waves and one soft
 * blob, each with its own seeded direction and place, so every badge gets its own pattern.
 * x, y are 0–1 across the card; r is the radius as a share of one cell (0–0.5).
 */
export function badgePattern(seed: number, cols: number, rows: number): Dot[] {
  const rand = seededRandom(seed);
  const waves = Array.from({ length: 3 }, () => {
    const angle = rand() * Math.PI * 2;
    const freq = 3 + rand() * 7;
    return { dx: Math.cos(angle) * freq, dy: Math.sin(angle) * freq, phase: rand() * Math.PI * 2, weight: 0.4 + rand() };
  });
  const total = waves.reduce((sum, w) => sum + w.weight, 0);
  const blob = { x: 0.15 + rand() * 0.7, y: 0.2 + rand() * 0.55, size: 0.16 + rand() * 0.18 };
  const aspect = rows / cols;
  const dots: Dot[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) / cols;
      const y = (j + 0.5) / rows;
      let wave = 0;
      for (const w of waves) wave += w.weight * Math.sin(x * w.dx + y * aspect * w.dy + w.phase);
      const dist = (x - blob.x) ** 2 + ((y - blob.y) * aspect) ** 2;
      const v = Math.min(1, Math.max(0, 0.42 * (wave / total + 1) * 0.8 + 0.75 * Math.exp(-dist / (2 * blob.size ** 2)) - 0.18));
      const r = 0.5 * v ** 1.4;
      if (r > 0.04) dots.push({ x, y, r });
    }
  }
  return dots;
}

export type BloomDot = { x: number; y: number; r: number; /** Opacity, 0–1. */ a: number };

/**
 * The card's dither bloom: a full lattice of dots over a w × h card, biggest and most solid at
 * the corner (cx, cy) and gone `reach` px away. The seed decides how big each dot wants to be
 * (cells the pattern left empty still get a small one), so every badge blooms differently.
 * Opacity comes in 16 steps, so a drawing can fill each step in one go.
 */
export function badgeBloom(seed: number, w: number, h: number, cx: number, cy: number, reach: number, cols = 34): BloomDot[] {
  const rows = Math.round((cols * h) / w);
  const cell = w / cols;
  const want = new Float32Array(cols * rows);
  for (const d of badgePattern(seed, cols, rows)) want[Math.floor(d.y * rows) * cols + Math.floor(d.x * cols)] = d.r / 0.5;
  const steps = 16;
  const dots: BloomDot[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * cell;
      const y = (j + 0.5) * cell;
      const near = 1 - Math.hypot(x - cx, y - cy) / reach;
      if (near <= 0.02) continue;
      const r = cell * 0.46 * (0.2 + 0.8 * want[j * cols + i]) * near ** 0.7;
      if (r < 0.6) continue;
      const step = Math.min(steps - 1, Math.floor(near * steps));
      dots.push({ x, y, r, a: Math.min(1, 0.12 + 0.88 * ((step + 1) / steps) ** 1.1) });
    }
  }
  return dots;
}

/**
 * The badge's seal: a small square of dots (n × n) whose sizes come from the seed, so it works
 * like a fingerprint in the corner of the card. Radius as a share of one cell (0.12–0.46).
 */
export function badgeSeal(seed: number, n = 7): number[] {
  const rand = seededRandom(seed ^ 0x9e3779b9);
  return Array.from({ length: n * n }, () => 0.12 + rand() * 0.34);
}

/** "Nov 2026" from an ISO date; empty when the date can't be read. */
export function monthYear(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

// ── words on the card ──

export function badgeNumber(n: number): string {
  return String(n).padStart(4, "0");
}

export function tierLabel(tier: string): string {
  if (tier === EARLY_ACCESS) return "Early access";
  return SPONSOR_TIERS.find((t) => t.id === tier)?.name ?? "Early access";
}

/** Initials for the company tile when there is no logo: "Acme Labs" → "AL". */
export function initials(text: string): string {
  const words = text.trim().split(/[\s\-_.&]+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "").slice(0, 2)).toUpperCase();
}

/** Main line and the line under it: the name over the company, or the company alone. */
export function badgeLines(badge: Pick<PublicBadge, "name" | "company">): { title: string; subtitle: string } {
  const name = badge.name.trim();
  const company = badge.company.trim();
  if (name) return { title: name, subtitle: company };
  return { title: company || "Early member", subtitle: "" };
}

/** Text people post with their badge. */
export function shareText(badge: Pick<PublicBadge, "number">): string {
  return `I'm Nº ${badgeNumber(badge.number)} on the Ragis waitlist: answers from your company's documents, each one with its source.`;
}
