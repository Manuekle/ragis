// Draws the badge into 2D canvases: the front and back of the card and the lanyard strip. The 3D
// scene uses them as textures and the flat fallback shows the front as is, so both always match.
//
// The card is a piece of the app: its light or dark surface (lib/badge.ts takes the colors from
// the app's tokens), its one blue, its dashed guides and corner crosses, and its dither, here a
// halftone bloom in the top right corner grown from the badge id. Universal Sans for the name,
// Lanterne for the wordmark and the italic accent (the company, in blue, like the accent words
// in the page titles), mono only for small meta. Sentence case everywhere.
//
// The text block is anchored to the bottom rule and grows upward, so a card with only a number
// on it and one with a logo, a two-line name and a company are both filled the same way.

import { LOGO_PATH } from "@/components/Logo";
import { alpha, BADGE_THEMES, BAND_COLOR, badgeBloom, badgeLines, badgeNumber, type BadgePalette, badgeSeal, type BadgeTheme, initials, mix, monthYear, type PublicBadge, seedOf, tierLabel } from "@/lib/badge";

export const CARD_PX = { w: 1024, h: 1440 };
export const BAND_PX = { w: 640, h: 256 };
/** Corner radius of the card on its texture; the 3D card is cut to the same curve. */
export const CARD_RADIUS_PX = 58;

const SANS = '"Universal Sans", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
const SERIF = '"Lanterne", Baskerville, Georgia, serif';
const MONO = '"Basier Square Mono", ui-monospace, "SF Mono", Menlo, monospace';

/** Loads the brand fonts before the first draw; canvas text does not wait for them on its own. */
export async function loadBadgeFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  await Promise.allSettled([
    document.fonts.load(`400 120px ${SANS}`),
    document.fonts.load(`400 120px ${SERIF}`),
    document.fonts.load(`italic 400 60px ${SERIF}`),
    document.fonts.load(`400 30px ${MONO}`),
  ]);
}

export type BadgeLogo = HTMLImageElement | HTMLCanvasElement;

export type BadgeArt = {
  badge: Pick<PublicBadge, "slug" | "number" | "name" | "company" | "tier" | "createdAt">;
  theme: BadgeTheme;
  logo: BadgeLogo | null;
  /** The logo is a solid square picture: it covers its tile instead of sitting on a white one. */
  logoFill?: boolean;
  /** Where the badge lives, printed on the back (e.g. "ragis.app"). */
  host: string;
};

let markPath: Path2D | null = null;

/** The Ragis mark, `size` px tall, top-left corner at x, y. */
function drawMark(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, fill: string) {
  markPath ??= new Path2D(LOGO_PATH);
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(size / 809, size / 809);
  ctx.translate(-222, -200);
  ctx.fillStyle = fill;
  ctx.fill(markPath);
  ctx.restore();
}

function setFont(ctx: CanvasRenderingContext2D, font: string, tracking = 0) {
  ctx.font = font;
  // letterSpacing is missing in older Safari; text still draws, just without the tracking.
  if ("letterSpacing" in ctx) (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = `${tracking}px`;
}

function prepare(canvas: HTMLCanvasElement, w: number, h: number): CanvasRenderingContext2D | null {
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

/** Splits `text` into lines no wider than `max` at the current font. */
function wrap(ctx: CanvasRenderingContext2D, text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width <= max || !line) line = next;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** Shortens one line with an ellipsis until it fits. */
function clip(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > max) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}…`;
}

/** The biggest size (down to `min`) at which `text` fits in two lines; longer text is cut. */
function fitTitle(ctx: CanvasRenderingContext2D, text: string, max: number, from: number, min: number) {
  const font = (size: number) => setFont(ctx, `400 ${size}px ${SANS}`, -0.045 * size);
  for (let size = from; size >= min; size -= 4) {
    font(size);
    const lines = wrap(ctx, text, max);
    if (lines.length <= 2 && lines.every((l) => ctx.measureText(l).width <= max)) return { size, lines };
  }
  font(min);
  const lines = wrap(ctx, text, max);
  return { size: min, lines: [clip(ctx, lines[0], max), ...(lines.length > 1 ? [clip(ctx, lines.slice(1).join(" "), max)] : [])] };
}

/** The card's surface: the app's neutral, a touch deeper toward the bottom. */
function ground(ctx: CanvasRenderingContext2D, p: BadgePalette, w: number, h: number) {
  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, p.ground);
  fill.addColorStop(1, p.groundDeep);
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, w, h);
}

/**
 * The dither bloom: a wash of the app's blue and a halftone field over it (badgeBloom), both
 * strongest at the corner (cx, cy) and gone `reach` px away.
 */
function bloom(ctx: CanvasRenderingContext2D, p: BadgePalette, seed: number, w: number, h: number, cx: number, cy: number, reach: number) {
  const wash = ctx.createRadialGradient(cx, cy, 0, cx, cy, reach);
  wash.addColorStop(0, alpha(p.accent, p.glow));
  wash.addColorStop(0.55, alpha(p.accent, p.glow * 0.3));
  wash.addColorStop(1, alpha(p.accent, 0));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, w, h);

  // One fill per opacity step.
  const groups = new Map<number, Path2D>();
  for (const d of badgeBloom(seed, w, h, cx, cy, reach)) {
    let group = groups.get(d.a);
    if (!group) groups.set(d.a, (group = new Path2D()));
    group.moveTo(d.x + d.r, d.y);
    group.arc(d.x, d.y, d.r, 0, Math.PI * 2);
  }
  for (const [a, group] of groups) {
    ctx.fillStyle = alpha(p.dot, a);
    ctx.fill(group);
  }
}

/** The app's dashed guide. */
function dashed(ctx: CanvasRenderingContext2D, p: BadgePalette, x1: number, y1: number, x2: number, y2: number) {
  ctx.save();
  ctx.strokeStyle = p.guide;
  ctx.lineWidth = 2;
  ctx.setLineDash([10, 10]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

/** The app's corner cross (the "+" where its guides meet). */
function cross(ctx: CanvasRenderingContext2D, p: BadgePalette, x: number, y: number) {
  ctx.fillStyle = p.cross;
  ctx.fillRect(x - 12, y - 1, 24, 2);
  ctx.fillRect(x - 1, y - 12, 2, 24);
}

/** A thin line printed just inside the edge, so the card reads as an object on any page. */
function hairline(ctx: CanvasRenderingContext2D, p: BadgePalette, w: number, h: number) {
  ctx.strokeStyle = p.hairline;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(1.5, 1.5, w - 3, h - 3, CARD_RADIUS_PX - 1.5);
  ctx.stroke();
}

const PLATE = 176;

/**
 * The company on the card: its logo on a white plate (logos are made for white), as wide as the
 * logo needs, or its initials in blue when there is no logo. A logo that is already a solid
 * square picture, like an app icon, becomes the plate itself. Returns false, with nothing drawn,
 * when there is neither a logo nor a company.
 */
function companyPlate(ctx: CanvasRenderingContext2D, p: BadgePalette, art: BadgeArt, x: number, y: number, maxW: number): boolean {
  const { logo } = art;
  const company = art.badge.company.trim();
  if (!logo && !company) return false;

  let plateW = PLATE;
  let lw = 0;
  let lh = 0;
  const cover = Boolean(logo && art.logoFill);
  if (logo && !cover) {
    const nw = "naturalWidth" in logo ? logo.naturalWidth : logo.width;
    const nh = "naturalHeight" in logo ? logo.naturalHeight : logo.height;
    const ratio = nw / nh || 1;
    const inner = PLATE - 56;
    // Square marks fill the plate's height; wide wordmarks stretch the plate instead.
    lh = ratio >= 1 ? Math.min(inner, (maxW - 72) / ratio) : inner;
    lw = lh * ratio;
    if (ratio > 1.15) {
      lh *= 0.74;
      lw = lh * ratio;
    }
    plateW = Math.max(PLATE, Math.round(lw + 72));
  }

  const radius = 40;
  ctx.save();
  ctx.shadowColor = "rgba(4, 12, 28, 0.28)";
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 14;
  ctx.beginPath();
  ctx.roundRect(x, y, plateW, PLATE, radius);
  ctx.fillStyle = "#ffffff";
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = "rgba(24, 24, 32, 0.08)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.roundRect(x + 1, y + 1, plateW - 2, PLATE - 2, radius - 1);
  ctx.stroke();

  if (logo) {
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, plateW, PLATE, radius);
    ctx.clip();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (cover) {
      // Cover the square: the shorter side fits, the longer one is centered and cut.
      const nw = "naturalWidth" in logo ? logo.naturalWidth : logo.width;
      const nh = "naturalHeight" in logo ? logo.naturalHeight : logo.height;
      const side = Math.min(nw, nh);
      ctx.drawImage(logo, (nw - side) / 2, (nh - side) / 2, side, side, x, y, PLATE, PLATE);
    } else ctx.drawImage(logo, x + (plateW - lw) / 2, y + (PLATE - lh) / 2, lw, lh);
    ctx.restore();
    if (cover) {
      // A dark icon on the dark card still needs an edge.
      ctx.strokeStyle = p.hairline;
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.roundRect(x + 1.5, y + 1.5, PLATE - 3, PLATE - 3, radius - 1.5);
      ctx.stroke();
    }
    return true;
  }
  const letters = initials(company);
  setFont(ctx, `400 ${letters.length > 1 ? 68 : 82}px ${SANS}`, -3);
  ctx.fillStyle = BADGE_THEMES.light.accentText;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(letters, x + plateW / 2 - 1.5, y + PLATE / 2 + 5);
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  return true;
}

export function drawFront(canvas: HTMLCanvasElement, art: BadgeArt) {
  const { w, h } = CARD_PX;
  const ctx = prepare(canvas, w, h);
  if (!ctx) return;
  const { badge } = art;
  const p = BADGE_THEMES[art.theme];
  const seed = seedOf(badge.slug);
  const pad = 88;
  const guide = 44;
  const rule = h - 300;

  ground(ctx, p, w, h);
  bloom(ctx, p, seed, w, h, w, 0, 1160);

  // the app's frame: guides down both sides, one across above the number, crosses where they meet
  dashed(ctx, p, guide, 0, guide, h);
  dashed(ctx, p, w - guide, 0, w - guide, h);
  dashed(ctx, p, 0, rule, w, rule);
  cross(ctx, p, guide, rule);
  cross(ctx, p, w - guide, rule);

  // top left: our mark and name
  drawMark(ctx, pad, 100, 62, p.text);
  setFont(ctx, `400 66px ${SERIF}`, -1.4);
  ctx.fillStyle = p.text;
  ctx.textBaseline = "middle";
  ctx.fillText("Ragis", pad + 82, 100 + 31 + 4);
  ctx.textBaseline = "alphabetic";

  // the text block, laid out upward from the rule: company, name, tier, logo
  const { title, subtitle } = badgeLines(badge);
  let y = rule - 78;
  if (subtitle) {
    setFont(ctx, `italic 400 68px ${SERIF}`, -1.2);
    ctx.fillStyle = p.accentText;
    ctx.fillText(clip(ctx, subtitle, w - pad * 2), pad, y);
    y -= 96;
  }
  const fit = fitTitle(ctx, title, w - pad * 2, 132, 72);
  ctx.fillStyle = p.text;
  for (let i = fit.lines.length - 1; i >= 0; i--) {
    ctx.fillText(fit.lines[i], pad - fit.size * 0.045, y);
    y -= fit.size * 1.02;
  }
  y += fit.size * 1.02 - fit.size * 0.74;

  y -= 44;
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  ctx.arc(pad + 10, y - 12, 10, 0, Math.PI * 2);
  ctx.fill();
  setFont(ctx, `400 36px ${MONO}`, -0.7);
  ctx.fillStyle = p.muted;
  ctx.fillText(clip(ctx, tierLabel(badge.tier), w - pad * 2 - 36), pad + 36, y);

  companyPlate(ctx, p, art, pad, y - 34 - 46 - PLATE, w - pad * 2);

  // the number, the date, and the seal: a square of dots grown from the badge id
  const base = h - 84;
  setFont(ctx, `400 36px ${MONO}`, -0.7);
  ctx.fillStyle = p.faint;
  ctx.fillText("Nº", pad, rule + 78);
  ctx.textAlign = "right";
  ctx.fillText(monthYear(badge.createdAt), w - pad, rule + 78);
  ctx.textAlign = "left";
  setFont(ctx, `400 136px ${SANS}`, -6.2);
  ctx.fillStyle = p.text;
  ctx.fillText(badgeNumber(badge.number), pad - 7, base);

  const n = 7;
  const box = 126;
  const cell = box / n;
  const sx = w - pad - box;
  const sy = base - box + 2;
  ctx.fillStyle = p.accent;
  ctx.beginPath();
  badgeSeal(seed, n).forEach((r, i) => {
    const cx = sx + (i % n) * cell + cell / 2;
    const cy = sy + Math.floor(i / n) * cell + cell / 2;
    ctx.moveTo(cx + r * cell, cy);
    ctx.arc(cx, cy, r * cell, 0, Math.PI * 2);
  });
  ctx.fill();

  hairline(ctx, p, w, h);
}

export function drawBack(canvas: HTMLCanvasElement, art: BadgeArt) {
  const { w, h } = CARD_PX;
  const ctx = prepare(canvas, w, h);
  if (!ctx) return;
  const p = BADGE_THEMES[art.theme];
  const guide = 44;

  ground(ctx, p, w, h);
  bloom(ctx, p, seedOf(art.badge.slug) ^ 0x5bd1e995, w, h, 0, h, 1240);
  dashed(ctx, p, guide, 0, guide, h);
  dashed(ctx, p, w - guide, 0, w - guide, h);

  const mark = 184;
  const top = h * 0.29;
  drawMark(ctx, (w - mark) / 2, top, mark, p.text);
  setFont(ctx, `400 132px ${SERIF}`, -2.6);
  ctx.fillStyle = p.text;
  ctx.textAlign = "center";
  ctx.fillText("Ragis", w / 2, top + mark + 160);

  // "Answers your company can cite." with the last word in serif italic, as on the waitlist page
  setFont(ctx, `400 46px ${SANS}`, -1.4);
  const lead = "Answers your company can ";
  const leadW = ctx.measureText(lead).width;
  setFont(ctx, `italic 400 54px ${SERIF}`, -0.8);
  const accentW = ctx.measureText("cite.").width;
  const x = (w - leadW - accentW) / 2;
  const y = top + mark + 262;
  ctx.textAlign = "left";
  setFont(ctx, `400 46px ${SANS}`, -1.4);
  ctx.fillStyle = p.muted;
  ctx.fillText(lead, x, y);
  setFont(ctx, `italic 400 54px ${SERIF}`, -0.8);
  ctx.fillStyle = p.accentText;
  ctx.fillText("cite.", x + leadW, y);

  setFont(ctx, `400 36px ${MONO}`, -0.7);
  ctx.fillStyle = p.faint;
  ctx.textAlign = "center";
  ctx.fillText(`Nº ${badgeNumber(art.badge.number)} · ${art.host}/waitlist`, w / 2, h - 100);
  ctx.textAlign = "left";

  hairline(ctx, p, w, h);
}

/** One stretch of the lanyard, in the app's blue; the 3D strap repeats it along its length. */
export function drawBand(canvas: HTMLCanvasElement) {
  const { w, h } = BAND_PX;
  const ctx = prepare(canvas, w, h);
  if (!ctx) return;
  // woven look: the blue is a little deeper at both edges, with a stitched line inside each
  const weave = ctx.createLinearGradient(0, 0, 0, h);
  weave.addColorStop(0, mix(BAND_COLOR, "#000000", 0.26));
  weave.addColorStop(0.16, BAND_COLOR);
  weave.addColorStop(0.84, BAND_COLOR);
  weave.addColorStop(1, mix(BAND_COLOR, "#000000", 0.26));
  ctx.fillStyle = weave;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "rgba(255, 255, 255, 0.26)";
  ctx.fillRect(0, 24, w, 3);
  ctx.fillRect(0, h - 27, w, 3);

  drawMark(ctx, 70, h / 2 - 44, 88, "#ffffff");
  setFont(ctx, `400 104px ${SERIF}`, -2);
  ctx.fillStyle = "#ffffff";
  ctx.textBaseline = "middle";
  ctx.fillText("Ragis", 182, h / 2 + 8);
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
  ctx.beginPath();
  ctx.arc(w - 64, h / 2, 9, 0, Math.PI * 2);
  ctx.fill();
}

export function drawAll(canvases: { front: HTMLCanvasElement; back: HTMLCanvasElement; band: HTMLCanvasElement }, art: BadgeArt) {
  drawFront(canvases.front, art);
  drawBack(canvases.back, art);
  drawBand(canvases.band);
}
