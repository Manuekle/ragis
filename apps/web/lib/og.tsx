import { readFile } from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { ImageResponse } from "next/og";
import { LOGO_PATH } from "@/components/Logo";
import type { IllustrationName } from "@/components/Illustration";

/**
 * Share cards for the public pages (1200 × 630, what LinkedIn, X, Slack and iMessage show).
 * Each one is the hero in miniature, in the dark theme: dashed column guides with crosses,
 * the headline in Universal Sans with its accent word in Lanterne italic, the mono check row,
 * the Ragis drawing for that page, and the blue dither horizon underneath.
 *
 * The cards are rendered at build time (each opengraph-image.tsx is static), so the fonts and
 * drawings are read from the source tree, not from the server at request time.
 */

export const OG_SIZE = { width: 1200, height: 630 };
export const OG_TYPE = "image/png";

const W = OG_SIZE.width;
const H = OG_SIZE.height;

// Dark theme tokens (app/globals.css, the hero's .gate).
const C = {
  bg: "#17171a",
  text: "#ececef",
  text2: "#cfcfd4",
  muted: "#aeaeb5",
  faint: "#94949d",
  accentText: "#5eb0ff",
  guide: "rgba(236, 236, 239, 0.14)",
  cross: "rgba(236, 236, 239, 0.38)",
  dither: ["#08254d", "#0a84ff", "#9fd0ff"] as const,
};

// ───────────── fonts ─────────────
// Satori reads TTF/OTF/WOFF, not WOFF2: assets/og-fonts holds the brand fonts decompressed
// from public/fonts (fonttools ttLib.woff2 decompress). Universal Sans is a TTF already.

type Font = { name: string; data: ArrayBuffer; weight: 300 | 400; style: "normal" | "italic" };

const fontFile = (rel: string) =>
  readFile(path.join(process.cwd(), rel)).then((buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);

let fonts: Promise<Font[]> | undefined;
function loadFonts(): Promise<Font[]> {
  fonts ??= Promise.all([
    fontFile("public/fonts/UniversalSans-Display-450-Trial.ttf").then((data): Font => ({ name: "Universal Sans", data, weight: 400, style: "normal" })),
    fontFile("assets/og-fonts/Lanterne-Regular-Trial.otf").then((data): Font => ({ name: "Lanterne", data, weight: 400, style: "normal" })),
    fontFile("assets/og-fonts/Lanterne-Italic-Trial.otf").then((data): Font => ({ name: "Lanterne", data, weight: 400, style: "italic" })),
    fontFile("assets/og-fonts/BasierSquareMono-Regular.ttf").then((data): Font => ({ name: "Basier Square Mono", data, weight: 400, style: "normal" })),
  ]);
  return fonts;
}

// ───────────── the drawing ─────────────

/** The page's Ragis drawing (public/illustrations/ragis-<name>-dark.svg), 1651 × 953, as a data URI. */
async function illustration(name: IllustrationName): Promise<string> {
  const svg = await readFile(path.join(process.cwd(), `public/illustrations/ragis-${name}-dark.svg`));
  return `data:image/svg+xml;base64,${svg.toString("base64")}`;
}

// ───────────── the dither horizon ─────────────
// A still frame of DitherField's "horizon" pattern (components/DitherField.tsx): the same light
// field, 8 × 8 ordered-dither threshold and three-stop ramp, computed here on the CPU and written
// out as a PNG, one square dot per DOT × DOT block.

const DOT = 2;

const fract = (x: number) => x - Math.floor(x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smoothstep = (e0: number, e1: number, x: number) => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};
const hash = (x: number, y: number) => fract(Math.sin(x * 127.1 + y * 311.7) * 43758.5453);
function noise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = fract(x);
  const fy = fract(y);
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  return mix(mix(hash(ix, iy), hash(ix + 1, iy), ux), mix(hash(ix, iy + 1), hash(ix + 1, iy + 1), ux), uy);
}
function fbm(x: number, y: number): number {
  let sum = 0;
  let amp = 0.5;
  for (let i = 0; i < 5; i++) {
    sum += amp * noise(x, y);
    [x, y] = [(0.8 * x - 0.6 * y) * 2 + 11.7, (0.6 * x + 0.8 * y) * 2 + 11.7];
    amp *= 0.5;
  }
  return sum;
}

/** The horizon's brightness at p (y measured up from the bottom edge), as in the shader at time t. */
function horizon(px: number, py: number, w: number, h: number, sunX: number, t = 10): number {
  const r = Math.max(Math.min(w * 0.42, h * 0.8), 90);
  const dx = (px - sunX) / (1.25 * r);
  const dy = (py + 0.15 * r) / r;
  const wobble = fbm(Math.atan2(dy, dx) * 1.8, t * 0.04) - 0.5;
  const rim = Math.hypot(dx, dy) * (1 + 0.14 * wobble);
  const sun = Math.exp(-3.4 * Math.max(rim - 0.42, 0)) * 0.78;
  const hh = py / r;
  const drift = (fbm(px / 320, t * 0.03) - 0.5) * 2.4;
  const band = 0.5 + 0.5 * Math.sin(Math.log(1 + 7 * hh) * 8 - t * 0.45 + drift);
  const haze = smoothstep(0.25, 0.95, band) * Math.exp(-1.9 * hh) * 0.5;
  const ground = Math.exp(-py / 22) * 0.32;
  const sides = smoothstep(0, 0.2, px / w) * smoothstep(1, 0.8, px / w);
  return (sun * (1 + haze) + haze * 0.35 + ground) * sides;
}

/** 8 × 8 ordered-dither threshold, built from [0 2; 3 1] like the shader's. */
function threshold(cx: number, cy: number): number {
  let sum = 0;
  let weight = 16;
  for (let i = 0; i < 3; i++) {
    sum += weight * ((2 * (cx & 1) + 3 * (cy & 1)) % 4);
    cx >>= 1;
    cy >>= 1;
    weight *= 0.25;
  }
  return (sum + 0.5) / 64;
}

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/** The dither band, w × h pixels, its sun centred at sunX, as a PNG data URI. */
function ditherUri(w: number, h: number, sunX: number, intensity = 0.8): string {
  const [low, mid, high] = C.dither.map(rgb);
  const cols = Math.ceil(w / DOT);
  const rows = Math.ceil(h / DOT);
  const px = new Uint8Array(w * h * 4);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const x = (i + 0.5) * DOT;
      const yUp = h - (j + 0.5) * DOT;
      // The shader adds a blurred copy of the field (its "halo"); the field is smooth, so it is ~0.55 more of itself.
      // Fade the left side, where the lead and checks sit, so the copy never lands on bright dots.
      let v = horizon(x, yUp, w, h, sunX) * 1.55 * (0.12 + 0.88 * smoothstep(0.22 * w, 0.62 * w, x));
      const over = Math.max(v - 0.85, 0);
      v = Math.min(v, 0.85) + over / (1 + 4 * over);
      v = Math.min(Math.max(v * intensity, 0), 1);
      v = Math.max(v - 0.02, 0) / 0.98;
      if (v <= threshold(i, rows - 1 - j)) continue;
      const c = v < 0.5 ? low.map((a, k) => mix(a, mid[k], v * 2)) : mid.map((a, k) => mix(a, high[k], v * 2 - 1));
      for (let y = j * DOT; y < Math.min((j + 1) * DOT, h); y++) {
        for (let x2 = i * DOT; x2 < Math.min((i + 1) * DOT, w); x2++) {
          const o = (y * w + x2) * 4;
          px[o] = c[0];
          px[o + 1] = c[1];
          px[o + 2] = c[2];
          px[o + 3] = 255;
        }
      }
    }
  }
  return `data:image/png;base64,${png(w, h, px).toString("base64")}`;
}

// A minimal PNG encoder (8-bit RGBA, no filtering), enough for the dither band.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8; // bit depth
  head[9] = 6; // RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

// ───────────── the card ─────────────

/** A headline line: plain text, with `{ em }` for the accent word set in Lanterne italic. */
export type OgLine = (string | { em: string })[];

export interface OgCard {
  /** Short page label in the top-right corner, e.g. "Pricing". */
  eyebrow: string;
  /** The headline, one array per line, broken where the page breaks it. */
  title: OgLine[];
  /** Headline size in px; long lines need less. */
  titleSize?: number;
  lead: string;
  checks: string[];
  art: IllustrationName;
}

// Guides: the column edges and the band around the headline, as on the hero.
const GX = [64, W - 64];
const GY_TOP = 104;
const PAD = 34;

function Guides({ bottom }: { bottom: number }) {
  const dash = { stroke: C.guide, strokeWidth: 1, strokeDasharray: "5 5" };
  const crosses = GX.flatMap((x) => [GY_TOP, bottom].map((y) => [x, y]));
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
      {GX.map((x) => (
        <line key={`x${x}`} x1={x + 0.5} y1={0} x2={x + 0.5} y2={H} {...dash} />
      ))}
      {[GY_TOP, bottom].map((y) => (
        <line key={`y${y}`} x1={0} y1={y + 0.5} x2={W} y2={y + 0.5} {...dash} />
      ))}
      {crosses.map(([x, y]) => (
        <g key={`${x}-${y}`} stroke={C.cross} strokeWidth={1}>
          <line x1={x - 5} y1={y + 0.5} x2={x + 6} y2={y + 0.5} />
          <line x1={x + 0.5} y1={y - 5} x2={x + 0.5} y2={y + 6} />
        </g>
      ))}
    </svg>
  );
}

function Check() {
  return (
    <svg width={18} height={18} viewBox="0 0 18 18">
      <circle cx={9} cy={9} r={9} fill="rgba(236, 236, 239, 0.62)" />
      <path d="M5.4 9.2 L7.8 11.5 L12.6 6.6" fill="none" stroke={C.bg} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export async function ogImage({ eyebrow, title, titleSize = 78, lead, checks, art }: OgCard): Promise<ImageResponse> {
  const [fontData, artUri] = await Promise.all([loadFonts(), illustration(art)]);

  const lineHeight = 1.02;
  const titleBottom = Math.round(GY_TOP + PAD + title.length * titleSize * lineHeight + PAD + 4);
  // The drawing sits bottom right, its ground line just above the bottom edge.
  const artW = 640;
  const artH = Math.round((artW * 953) / 1651);
  const artLeft = W - artW - 4;
  const artTop = H - artH + 22;
  const band = 290;

  return new ImageResponse(
    (
      <div style={{ position: "relative", display: "flex", width: W, height: H, background: C.bg, fontFamily: "Universal Sans", color: C.text }}>
        <img src={ditherUri(W, band, artLeft + artW * 0.42)} width={W} height={band} style={{ position: "absolute", left: 0, top: H - band }} />
        <Guides bottom={titleBottom} />

        {/* header: the brand on the left, the page on the right */}
        <div style={{ position: "absolute", left: GX[0] + PAD, right: W - GX[1] + PAD, top: 0, height: GY_TOP, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <svg width={30} height={30} viewBox="222 200 806 809">
              <path fill={C.text} d={LOGO_PATH} />
            </svg>
            <span style={{ fontFamily: "Lanterne", fontSize: 33, letterSpacing: -0.6, color: C.text }}>Ragis</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "Basier Square Mono", fontSize: 17, letterSpacing: 1.4, textTransform: "uppercase", color: C.faint }}>
            <div style={{ width: 8, height: 8, borderRadius: 4, background: "#0a84ff" }} />
            {eyebrow}
          </div>
        </div>

        {/* headline */}
        <div style={{ position: "absolute", left: GX[0] + PAD, top: GY_TOP + PAD - 2, display: "flex", flexDirection: "column" }}>
          {title.map((line, i) => (
            <div key={i} style={{ display: "flex", alignItems: "baseline", fontSize: titleSize, lineHeight, letterSpacing: -0.045 * titleSize, height: titleSize * lineHeight }}>
              {line.map((part, k) =>
                typeof part === "string" ? (
                  <span key={k} style={{ whiteSpace: "pre" }}>
                    {part}
                  </span>
                ) : (
                  <span key={k} style={{ whiteSpace: "pre", fontFamily: "Lanterne", fontStyle: "italic", letterSpacing: -0.02 * titleSize, color: C.accentText }}>
                    {part.em}
                  </span>
                ),
              )}
            </div>
          ))}
        </div>

        {/* lead and checks, left of the drawing */}
        <div style={{ position: "absolute", left: GX[0] + PAD, top: titleBottom + 30, width: 470, display: "flex", flexDirection: "column", gap: 24 }}>
          <div style={{ display: "flex", fontSize: 25, lineHeight: 1.42, letterSpacing: -0.3, color: C.muted }}>{lead}</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "12px 22px" }}>
            {checks.map((item) => (
              <div key={item} style={{ display: "flex", alignItems: "center", gap: 9, fontSize: 18, letterSpacing: -0.1, color: C.text2 }}>
                <Check />
                {item}
              </div>
            ))}
          </div>
        </div>

        <img src={artUri} width={artW} height={artH} style={{ position: "absolute", left: artLeft, top: artTop }} />
      </div>
    ),
    { ...OG_SIZE, fonts: fontData },
  );
}
