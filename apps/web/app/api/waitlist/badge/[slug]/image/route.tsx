import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";
import { LOGO_PATH } from "@/components/Logo";
import { BADGE_THEMES, BAND_COLOR, badgeBloom, badgeLines, badgeNumber, type BadgePalette, badgeSeal, type BadgeTheme, initials, isBadgeTheme, mix, monthYear, type PublicBadge, seedOf, tierLabel } from "@/lib/badge";
import { badgeLogo } from "@/lib/badge-logo";
import { findBadge } from "@/lib/waitlist-db";

export const runtime = "nodejs";

/**
 * The share image of a badge (1200 × 630, the size LinkedIn and X show in a post). A flat
 * version of the 3D card in the look its owner had on screen (light or dark), drawn with the
 * same bloom, colors and words as components/badge/draw.ts. `?download=1` sends it as a file.
 */

type Font = { name: string; data: ArrayBuffer; weight: 400; style: "normal" };
let fonts: Promise<Font[]> | undefined;

/** Universal Sans from public/fonts. Satori can't read woff2, so the other brand fonts are left out. */
function loadFonts(): Promise<Font[]> {
  fonts ??= readFile(path.join(process.cwd(), "public/fonts/UniversalSans-Display-450-Trial.ttf"))
    .then((buf) => [{ name: "Universal Sans", data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, weight: 400 as const, style: "normal" as const }])
    .catch(() => []);
  return fonts;
}

function svgUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

/** The dither bloom (lib/badge.ts) as an SVG picture, w × h, in the palette's dot color. */
function bloomUri(p: BadgePalette, seed: number, w: number, h: number, cx: number, cy: number, reach: number): string {
  const dots = badgeBloom(seed, w, h, cx, cy, reach)
    .map((d) => `<circle cx="${d.x.toFixed(1)}" cy="${d.y.toFixed(1)}" r="${d.r.toFixed(2)}" fill-opacity="${d.a.toFixed(2)}"/>`)
    .join("");
  return svgUri(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><g fill="${p.dot}">${dots}</g></svg>`);
}

function Mark({ size, color }: { size: number; color: string }) {
  return (
    <svg width={size} height={size} viewBox="222 200 806 809">
      <path fill={color} d={LOGO_PATH} />
    </svg>
  );
}

/** Font size (in card pixels, 1024 wide) at which the title fits in two lines, as the canvas does. */
function titleSize(title: string): number {
  const longest = Math.max(...title.split(/\s+/).map((w) => w.length), 1);
  return Math.round(Math.min(132, Math.max(72, 3500 / Math.max(title.length, 1)), 1650 / longest));
}

/** The front of the card, `width` px wide. Positions follow drawFront() on its 1024 × 1440 canvas. */
function Card({ badge, theme, logo, width }: { badge: PublicBadge; theme: BadgeTheme; logo: { uri: string; ratio: number; fill: boolean } | null; width: number }) {
  const p = BADGE_THEMES[theme];
  const k = width / 1024;
  const height = 1440 * k;
  const pad = 88 * k;
  const guide = 44 * k;
  const rule = 300 * k;
  const plate = 176 * k;
  const { title, subtitle } = badgeLines(badge);
  const size = titleSize(title) * k;
  const company = badge.company.trim();
  const seal = badgeSeal(seedOf(badge.slug));
  const dash = `${2 * k}px dashed ${p.guide}`;
  const glow = Math.round(p.glow * 255).toString(16).padStart(2, "0");
  // Square marks fill the plate's height; wide wordmarks stretch the plate instead.
  const inner = plate - 56 * k;
  const logoH = logo ? (logo.ratio > 1.15 ? 0.74 : 1) * (logo.ratio >= 1 ? Math.min(inner, (width - pad * 2 - 72 * k) / logo.ratio) : inner) : 0;
  const logoW = logo ? logoH * logo.ratio : 0;

  return (
    <div style={{ position: "relative", display: "flex", width, height, borderRadius: 58 * k, overflow: "hidden", backgroundImage: `linear-gradient(180deg, ${p.ground} 0%, ${p.groundDeep} 100%)` }}>
      <div style={{ position: "absolute", left: 0, top: 0, width, height, display: "flex", backgroundImage: `radial-gradient(circle at 100% 0%, ${p.accent}${glow} 0%, ${p.accent}00 72%)` }} />
      <img src={bloomUri(p, seedOf(badge.slug), Math.round(width), Math.round(height), width, 0, 1160 * k)} width={width} height={height} style={{ position: "absolute", left: 0, top: 0 }} />

      <div style={{ position: "absolute", left: guide, top: 0, height, borderLeft: dash }} />
      <div style={{ position: "absolute", right: guide, top: 0, height, borderLeft: dash }} />
      <div style={{ position: "absolute", left: 0, bottom: rule, width, borderTop: dash }} />

      <div style={{ position: "absolute", left: pad, top: 100 * k, display: "flex", alignItems: "center", gap: 20 * k, color: p.text }}>
        <Mark size={62 * k} color={p.text} />
        <span style={{ fontSize: 62 * k, letterSpacing: -2 * k }}>Ragis</span>
      </div>

      {/* the text block grows upward from the rule: logo, tier, name, company */}
      <div style={{ position: "absolute", left: pad, bottom: rule + 62 * k, width: width - pad * 2, display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
        {(logo || company) && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", width: logo && !logo.fill ? Math.max(plate, logoW + 72 * k) : plate, height: plate, marginBottom: 46 * k, borderRadius: 40 * k, background: "#ffffff", boxShadow: `0 ${14 * k}px ${36 * k}px rgba(4,12,28,0.28)` }}>
            {logo?.fill ? <img src={logo.uri} width={plate} height={plate} style={{ objectFit: "cover" }} /> : logo ? <img src={logo.uri} width={logoW} height={logoH} /> : <span style={{ fontSize: (initials(company).length > 1 ? 68 : 82) * k, letterSpacing: -3 * k, color: BADGE_THEMES.light.accentText }}>{initials(company)}</span>}
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 16 * k, marginBottom: 26 * k, fontSize: 34 * k, color: p.muted }}>
          <div style={{ width: 20 * k, height: 20 * k, borderRadius: 10 * k, background: p.accent }} />
          {tierLabel(badge.tier)}
        </div>
        <div style={{ display: "flex", marginLeft: -size * 0.045, fontSize: size, lineHeight: 1.02, letterSpacing: -0.045 * size, color: p.text }}>{title}</div>
        {subtitle && <div style={{ display: "flex", marginTop: 20 * k, fontSize: 60 * k, letterSpacing: -1.5 * k, color: p.accentText }}>{subtitle}</div>}
      </div>

      <div style={{ position: "absolute", left: pad, right: pad, bottom: rule - 96 * k, display: "flex", justifyContent: "space-between", fontSize: 34 * k, color: p.faint }}>
        <span>Nº</span>
        <span>{monthYear(badge.createdAt)}</span>
      </div>
      <div style={{ position: "absolute", left: pad - 7 * k, bottom: 84 * k - 30 * k, display: "flex", fontSize: 136 * k, lineHeight: 1, letterSpacing: -6.2 * k, color: p.text }}>{badgeNumber(badge.number)}</div>
      <div style={{ position: "absolute", right: pad, bottom: 82 * k, display: "flex", flexWrap: "wrap", width: 126 * k, height: 126 * k }}>
        {seal.map((r, i) => (
          <div key={i} style={{ width: (126 / 7) * k, height: (126 / 7) * k, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <div style={{ width: 2 * r * (126 / 7) * k, height: 2 * r * (126 / 7) * k, borderRadius: 999, background: p.accent }} />
          </div>
        ))}
      </div>

      <div style={{ position: "absolute", left: 0, top: 0, width, height, display: "flex", borderRadius: 58 * k, border: `${Math.max(1, 3 * k)}px solid ${p.hairline}` }} />
    </div>
  );
}

/** Width over height of a PNG or JPEG, read from its header; 1 when it can't be read. */
function imageRatio(bytes: Uint8Array, type: string): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (type === "image/png" && bytes.length > 24) return view.getUint32(16) / view.getUint32(20) || 1;
  // JPEG: walk the segments to the frame header (SOF0–SOF15, minus the three that are not frames).
  for (let i = 2; type === "image/jpeg" && i + 9 < bytes.length && bytes[i] === 0xff; ) {
    const marker = bytes[i + 1];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return view.getUint16(i + 7) / view.getUint16(i + 5) || 1;
    i += 2 + view.getUint16(i + 2);
  }
  return 1;
}

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const found = await findBadge((await params).slug).catch(() => null);
  if (!found) return new Response("Badge not found.", { status: 404 });
  const { domain: _domain, ...badge } = found;
  const query = new URL(req.url).searchParams;
  // The look the owner last had on screen; dark until they have opened their badge.
  const asked = query.get("theme");
  const theme: BadgeTheme = isBadgeTheme(asked) ? asked : (badge.theme ?? "dark");
  const p = BADGE_THEMES[theme];
  const [file, fontList] = await Promise.all([badgeLogo(found).catch(() => null), loadFonts()]);
  const logo = file ? { uri: `data:${file.type};base64,${Buffer.from(file.bytes).toString("base64")}`, ratio: imageRatio(new Uint8Array(file.bytes), file.type), fill: badge.logoFill } : null;
  const { title } = badgeLines(badge);
  const host = (process.env.PUBLIC_BASE_URL ? URL.parse(process.env.PUBLIC_BASE_URL)?.host : null) ?? new URL(req.url).host;
  const download = query.has("download");
  const cardW = 304;

  return new ImageResponse(
    (
      <div style={{ width: 1200, height: 630, display: "flex", position: "relative", background: p.page, color: p.text, fontFamily: fontList.length ? "Universal Sans" : undefined }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: 1200, height: 630, display: "flex", backgroundImage: `radial-gradient(circle at 100% 0%, ${p.accent}${theme === "dark" ? "59" : "33"} 0%, ${p.accent}00 60%)` }} />
        <img src={bloomUri(p, seedOf(badge.slug) ^ 0x2545f491, 1200, 630, 1200, 0, 900)} width={1200} height={630} style={{ position: "absolute", left: 0, top: 0, opacity: theme === "dark" ? 0.55 : 0.45 }} />

        <div style={{ position: "absolute", left: 72, top: 64, bottom: 64, width: 620, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <Mark size={40} color={p.text} />
            <span style={{ fontSize: 38, letterSpacing: -1.2 }}>Ragis</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 26, color: p.muted }}>
              <div style={{ width: 14, height: 14, borderRadius: 7, background: p.accent }} />
              Waitlist badge
            </div>
            <span style={{ fontSize: 132, lineHeight: 0.95, letterSpacing: -6 }}>Nº {badgeNumber(badge.number)}</span>
            <span style={{ fontSize: 40, lineHeight: 1.2, letterSpacing: -1, color: p.muted, maxWidth: 580 }}>{title === "Early member" ? "Joined the Ragis waitlist." : `${title} joined the Ragis waitlist.`}</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 24, color: p.faint }}>
            <span>Answers from your company&apos;s documents, each with its source.</span>
            <span style={{ color: p.accentText }}>{host}/waitlist</span>
          </div>
        </div>

        {/* the badge hanging from the top edge: strap, clip, card */}
        <div style={{ position: "absolute", left: 858, top: 0, width: 56, height: 96, display: "flex", backgroundImage: `linear-gradient(90deg, ${mix(BAND_COLOR, "#000000", 0.26)} 0%, ${BAND_COLOR} 16%, ${BAND_COLOR} 84%, ${mix(BAND_COLOR, "#000000", 0.26)} 100%)` }} />
        <div style={{ position: "absolute", left: 850, top: 84, width: 72, height: 34, borderRadius: 7, display: "flex", backgroundImage: "linear-gradient(180deg, #f4f4f6 0%, #b9b9c0 100%)" }} />
        <div style={{ position: "absolute", left: 882, top: 112, width: 8, height: 22, display: "flex", background: "#c4c4ca" }} />
        <div style={{ position: "absolute", left: 886 - cardW / 2, top: 142, display: "flex", borderRadius: (58 * cardW) / 1024, boxShadow: theme === "dark" ? "0 40px 80px -24px rgba(0,0,0,0.75)" : "0 40px 80px -28px rgba(24,24,32,0.4)" }}>
          <Card badge={badge} theme={theme} logo={logo} width={cardW} />
        </div>
        <div style={{ position: "absolute", left: 842, top: 128, width: 88, height: 36, borderRadius: 8, display: "flex", backgroundImage: "linear-gradient(180deg, #f4f4f6 0%, #b9b9c0 100%)", boxShadow: "0 2px 6px rgba(0,0,0,0.25)" }} />
      </div>
    ),
    {
      width: 1200,
      height: 630,
      fonts: fontList,
      headers: {
        "cache-control": "public, max-age=300, s-maxage=300",
        ...(download ? { "content-disposition": `attachment; filename="ragis-badge-${badge.number}.png"` } : {}),
      },
    },
  );
}
