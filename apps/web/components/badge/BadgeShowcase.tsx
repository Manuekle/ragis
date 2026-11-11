"use client";

import { Component, type ComponentType, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconBuilding, IconCheck, IconCopy, IconDownload, IconLinkedIn, IconSpinner, IconUpload, IconUser, IconXSocial } from "@/components/icons";
import { TextField } from "@/components/ui";
import { BADGE_THEMES, type BadgeTheme, COMPANY_MAX, LOGO_MAX_BYTES, LOGO_MAX_PX, NAME_MAX, type PublicBadge, shareText } from "@/lib/badge";
import type { BadgeCanvases, BadgeLayout, SceneProps } from "./BadgeScene";
import { type BadgeLogo, drawAll, loadBadgeFonts } from "./draw";
import "./badge.css";

type SceneComponent = ComponentType<SceneProps>;

const tokenKey = (slug: string) => `ragis:badge:${slug}`;

function readToken(slug: string): string | null {
  try {
    return localStorage.getItem(tokenKey(slug));
  } catch {
    return null;
  }
}

function hasWebGL(): boolean {
  try {
    const gl = document.createElement("canvas").getContext("webgl2") ?? document.createElement("canvas").getContext("webgl");
    gl?.getExtension("WEBGL_lose_context")?.loseContext();
    return Boolean(gl);
  } catch {
    return false;
  }
}

/** The look the app is in right now: the visitor's pick in the header, or their system's. */
function appTheme(): BadgeTheme {
  const picked = document.documentElement.dataset.theme;
  if (picked === "light" || picked === "dark") return picked;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Follows the app between light and dark. Null until the page is in the browser. */
function useAppTheme(): BadgeTheme | null {
  const [theme, setTheme] = useState<BadgeTheme | null>(null);
  useEffect(() => {
    const read = () => setTheme(appTheme());
    read();
    const picked = new MutationObserver(read);
    picked.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    system.addEventListener("change", read);
    return () => {
      picked.disconnect();
      system.removeEventListener("change", read);
    };
  }, []);
  return theme;
}

const LOGO_FILES = /^image\/(png|jpeg|webp|svg\+xml)$/;

/**
 * Turns the picked file into what the server stores: one PNG, at most LOGO_MAX_PX on a side,
 * with any empty margin around the logo cut off so it sits at full size on the card. It also
 * tells whether the picture is a solid square (an app icon, a mark on its own background), which
 * the card shows edge to edge. Throws a message meant for the person when the file can't be used.
 */
async function toLogoPng(file: File): Promise<{ blob: Blob; canvas: HTMLCanvasElement; fill: boolean }> {
  if (!LOGO_FILES.test(file.type)) throw new Error("That file isn't an image we can use. Try a PNG, JPG or SVG.");
  if (file.size > 10 * 1024 * 1024) throw new Error("That image is too large. Try one under 10 MB.");

  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {
      throw new Error("We couldn't open that image. Try another file.");
    });
    // An SVG without a size of its own reports none: give it a square to draw into.
    const iw = img.naturalWidth || LOGO_MAX_PX;
    const ih = img.naturalHeight || LOGO_MAX_PX;
    const vector = file.type === "image/svg+xml";

    for (const max of [LOGO_MAX_PX, 384, 256, 160]) {
      const scale = vector ? max / Math.max(iw, ih) : Math.min(1, max / Math.max(iw, ih));
      const full = document.createElement("canvas");
      full.width = Math.max(1, Math.round(iw * scale));
      full.height = Math.max(1, Math.round(ih * scale));
      const ctx = full.getContext("2d", { willReadFrequently: true });
      if (!ctx) break;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, full.width, full.height);

      // Find the box that holds every visible pixel, and whether anything is see-through at all.
      const { data } = ctx.getImageData(0, 0, full.width, full.height);
      let [x0, y0, x1, y1] = [full.width, full.height, -1, -1];
      let solid = true;
      for (let y = 0; y < full.height; y++) {
        for (let x = 0; x < full.width; x++) {
          const a = data[(y * full.width + x) * 4 + 3];
          if (a < 250) solid = false;
          if (a < 12) continue;
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
      if (x1 < x0 || y1 < y0) throw new Error("That image looks empty. Try another file.");

      const canvas = document.createElement("canvas");
      canvas.width = x1 - x0 + 1;
      canvas.height = y1 - y0 + 1;
      canvas.getContext("2d")?.drawImage(full, x0, y0, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
      const ratio = canvas.width / canvas.height;
      if (blob && blob.size <= LOGO_MAX_BYTES) return { blob, canvas, fill: solid && ratio > 0.85 && ratio < 1.18 };
    }
    throw new Error("That image is too detailed to use as a logo. Try a simpler file.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Falls back to the flat card if the 3D scene throws (no WebGL, physics engine failed to load). */
class SceneBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(err: unknown) {
    console.warn("[badge] 3D badge unavailable, showing the flat one:", err instanceof Error ? err.message : err);
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** The front of the card as a flat picture, hanging from a plain strap: shown where the 3D scene can't run. */
function FlatBadge({ source, version, label }: { source: HTMLCanvasElement | null; version: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = ref.current;
    if (!target || !source) return;
    target.width = source.width;
    target.height = source.height;
    target.getContext("2d")?.drawImage(source, 0, 0);
  }, [source, version]);
  return (
    <div className="badge-flat">
      <i className="badge-flat-strap" aria-hidden="true" />
      <i className="badge-flat-clip" aria-hidden="true" />
      <canvas ref={ref} role="img" aria-label={label} />
    </div>
  );
}

type Save = "idle" | "saving" | "saved" | "error";
/** loading: the 3D scene is on its way. flat: it can't run here, the picture stands in. */
type Mode = "loading" | "flat";

/**
 * A waitlist badge hanging in 3D from the top of the page, with what goes next to it. The badge
 * wears the app's look, light or dark, and changes with it. The person who made it (the edit
 * token is in this browser) can put their name and their company's logo on it and share it;
 * anyone else sees `guest` instead.
 */
export function BadgeShowcase({ badge: initial, editToken, header, guest }: { badge: PublicBadge; editToken?: string | null; header: ReactNode; guest?: ReactNode }) {
  const [badge, setBadge] = useState(initial);
  const [token, setToken] = useState<string | null>(editToken ?? null);
  const [name, setName] = useState(initial.name);
  const [company, setCompany] = useState(initial.company);
  const [logo, setLogo] = useState<BadgeLogo | null>(null);
  const [logoThumb, setLogoThumb] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [canvases, setCanvases] = useState<BadgeCanvases | null>(null);
  const [version, setVersion] = useState(0);
  const [Scene, setScene] = useState<SceneComponent | null>(null);
  const [mode, setMode] = useState<Mode>("loading");
  const [sceneReady, setSceneReady] = useState(false);
  const [layout, setLayout] = useState<BadgeLayout | null>(null);
  const [active, setActive] = useState(true);
  const [calm, setCalm] = useState(false);
  const [save, setSave] = useState<Save>("idle");
  const [copied, setCopied] = useState(false);
  const [origin, setOrigin] = useState("");
  const hangRef = useRef<HTMLDivElement>(null);
  const restRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pending = useRef<{ timer?: ReturnType<typeof setTimeout>; body?: Record<string, string> }>({});

  const theme = useAppTheme();
  const owner = Boolean(token);
  const shareUrl = `${origin}/waitlist/badge/${badge.slug}`;

  // Remember the edit token in this browser, so the owner can come back to the badge page and change it.
  useEffect(() => {
    if (editToken) {
      try {
        localStorage.setItem(tokenKey(initial.slug), editToken);
      } catch {}
    } else setToken(readToken(initial.slug));
  }, [editToken, initial.slug]);

  // Client-only setup: canvases, fonts, the 3D chunk (skipped without WebGL), reduced motion.
  useEffect(() => {
    setOrigin(window.location.origin);
    setCalm(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    setCanvases({ front: document.createElement("canvas"), back: document.createElement("canvas"), band: document.createElement("canvas") });
    loadBadgeFonts().finally(() => setFontsReady(true));
    if (!hasWebGL()) return setMode("flat");
    import("./BadgeScene")
      .then((m) => setScene(() => m.default as SceneComponent))
      .catch((err) => {
        console.warn("[badge] could not load the 3D badge:", err);
        setMode("flat");
      });
  }, []);

  // The company logo: the owner's upload, or the company's own icon.
  useEffect(() => {
    if (!badge.logoUrl) {
      setLogo(null);
      setLogoThumb(null);
      return;
    }
    let stale = false;
    const src = badge.logoUrl;
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      if (stale || img.naturalWidth < 16) return;
      setLogo(img);
      setLogoThumb(src);
    };
    img.onerror = () => {
      if (stale) return;
      setLogo(null);
      setLogoThumb(null);
    };
    img.src = src;
    return () => {
      stale = true;
    };
  }, [badge.logoUrl]);

  // Redraw the card whenever anything on it changes, the app's look included.
  useEffect(() => {
    if (!canvases || !fontsReady || !theme) return;
    drawAll(canvases, {
      badge: { ...badge, name, company },
      theme,
      logo,
      logoFill: badge.logoFill,
      host: window.location.host.replace(/^www\./, ""),
    });
    setVersion((v) => v + 1);
  }, [canvases, fontsReady, badge, name, company, theme, logo]);

  // Where the badge hangs. The page leaves a card-sized space for it (.badge-rest); the 3D layer
  // starts at the top of the page and ends a little under the stage, and the card is hung so it
  // comes to rest exactly on that space.
  useEffect(() => {
    const hang = hangRef.current;
    const rest = restRef.current;
    if (!hang || !rest) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Where an element sits on the page, from the layout alone: the stage slides in when the page
    // opens, and a position read mid-slide would hang the card a few pixels off.
    const onPage = (el: HTMLElement) => {
      let [left, top] = [0, 0];
      for (let at: HTMLElement | null = el; at; at = at.offsetParent as HTMLElement | null) {
        left += at.offsetLeft;
        top += at.offsetTop;
      }
      return { left, top };
    };
    const measure = () => {
      if (rest.offsetHeight < 1) return;
      const card = onPage(rest);
      const next: BadgeLayout = {
        width: document.documentElement.clientWidth,
        height: Math.round(onPage(hang).top + hang.offsetHeight + 120),
        x: Math.round(card.left + rest.offsetWidth / 2),
        y: Math.round(card.top + rest.offsetHeight / 2),
        card: rest.offsetHeight,
      };
      setLayout((prev) => (prev && prev.width === next.width && prev.height === next.height && prev.x === next.x && prev.y === next.y && prev.card === next.card ? prev : next));
    };
    // The first measure is immediate; later ones wait for the resize to settle, since each new layout hangs the badge again.
    measure();
    const settle = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, 180);
    };
    const watcher = new ResizeObserver(settle);
    watcher.observe(hang);
    watcher.observe(document.body);
    window.addEventListener("resize", settle);
    return () => {
      clearTimeout(timer);
      watcher.disconnect();
      window.removeEventListener("resize", settle);
    };
  }, []);

  // Pause the scene while it is off screen.
  useEffect(() => {
    const el = hangRef.current;
    if (!el || !("IntersectionObserver" in window)) return;
    const io = new IntersectionObserver(([entry]) => setActive(entry.isIntersecting), { rootMargin: "160px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const flush = useCallback(async () => {
    const { timer, body } = pending.current;
    clearTimeout(timer);
    pending.current = {};
    if (!body || !token) return;
    setSave("saving");
    try {
      const res = await fetch(`/api/waitlist/badge/${badge.slug}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, ...body }),
      });
      const data = (await res.json().catch(() => ({}))) as { badge?: PublicBadge };
      if (res.status === 403) setToken(null);
      if (!res.ok || !data.badge) throw new Error(String(res.status));
      setBadge(data.badge);
      setSave("saved");
    } catch {
      setSave("error");
    }
  }, [badge.slug, token]);

  /** Queues a change and saves it shortly after typing stops. */
  const queue = useCallback(
    (change: Record<string, string>, wait = 700) => {
      clearTimeout(pending.current.timer);
      pending.current.body = { ...pending.current.body, ...change };
      pending.current.timer = setTimeout(flush, wait);
    },
    [flush],
  );

  // The share image is drawn in the look the owner has on screen, so it matches what they saw.
  useEffect(() => {
    if (owner && theme && badge.theme !== theme) queue({ theme }, 400);
  }, [owner, theme, badge.theme, queue]);

  async function sendLogo(request: RequestInit, query = ""): Promise<boolean> {
    if (!token) return false;
    const res = await fetch(`/api/waitlist/badge/${badge.slug}/logo${query}`, { ...request, headers: { ...request.headers, "x-badge-token": token } });
    const data = (await res.json().catch(() => ({}))) as { badge?: PublicBadge; error?: { message?: string } };
    if (res.status === 403) setToken(null);
    if (!res.ok || !data.badge) throw new Error(data.error?.message ?? "Couldn't save your logo. Try again in a moment.");
    setBadge(data.badge);
    return true;
  }

  async function uploadLogo(file: File | undefined) {
    if (!file) return;
    setLogoBusy(true);
    setLogoError(null);
    try {
      const png = await toLogoPng(file);
      await sendLogo({ method: "PUT", headers: { "content-type": "image/png" }, body: png.blob }, png.fill ? "?fill=1" : "");
      // Show it at once; the saved copy replaces it when it has loaded.
      setLogo(png.canvas);
      setLogoThumb(png.canvas.toDataURL("image/png"));
    } catch (err) {
      setLogoError(err instanceof TypeError ? "Couldn't reach the server. Check your connection." : err instanceof Error ? err.message : "Couldn't save your logo. Try again in a moment.");
    }
    setLogoBusy(false);
  }

  async function removeLogo() {
    setLogoBusy(true);
    setLogoError(null);
    try {
      await sendLogo({ method: "DELETE" });
      // Off the card at once; the company's own icon, if there is one, follows when it has loaded.
      setLogo(null);
      setLogoThumb(null);
    } catch (err) {
      setLogoError(err instanceof TypeError ? "Couldn't reach the server. Check your connection." : err instanceof Error ? err.message : "Couldn't remove your logo. Try again in a moment.");
    }
    setLogoBusy(false);
  }

  async function copy() {
    void flush();
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {}
  }

  const text = shareText(badge);
  const label = `Ragis waitlist badge number ${badge.number}`;
  const three = mode === "loading" && Scene && canvases && fontsReady && theme && layout && version > 0;

  return (
    <div className="badge-show">
      <div ref={hangRef} className="badge-hang">
        {/* the card's resting place: the 3D card lands here; a touch that starts here grabs the card instead of scrolling */}
        <div ref={restRef} className="badge-rest">
          {mode === "flat" && <FlatBadge source={canvases?.front ?? null} version={version} label={label} />}
        </div>
        {sceneReady && mode === "loading" && <p className="badge-hint">Drag the badge</p>}
      </div>

      {three &&
        createPortal(
          <SceneBoundary onFail={() => setMode("flat")}>
            <div className="badge-layer" style={{ height: layout.height }} role="img" aria-label={label}>
              <Scene canvases={canvases} versions={{ front: version, back: version, band: version }} layout={layout} rim={BADGE_THEMES[theme].rim} shade={BADGE_THEMES[theme].shade} foil={badge.tier === "founding"} calm={calm} active={active} onReady={() => setSceneReady(true)} />
            </div>
          </SceneBoundary>,
          document.body,
        )}

      <div className="wl-card badge-panel">
        {header}

        {owner ? (
          <>
            <div className="badge-edit">
              <TextField
                label="Name on the badge"
                value={name}
                maxLength={NAME_MAX}
                placeholder="Your name"
                autoComplete="name"
                icon={IconUser}
                onChange={(e) => {
                  setName(e.target.value);
                  queue({ name: e.target.value });
                }}
              />
              <TextField
                label="Company"
                value={company}
                maxLength={COMPANY_MAX}
                placeholder="Where you work"
                autoComplete="organization"
                icon={IconBuilding}
                onChange={(e) => {
                  setCompany(e.target.value);
                  queue({ company: e.target.value });
                }}
              />

              <div className="badge-logo">
                <span className="label">Company logo</span>
                <div className="badge-logo-row">
                  <span className="badge-logo-thumb" data-empty={logoThumb ? undefined : ""} data-fill={logoThumb && badge.logoFill ? "" : undefined}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {logoThumb ? <img src={logoThumb} alt="" /> : <IconBuilding size={18} />}
                  </span>
                  <button type="button" className="gate-cta quiet badge-logo-btn" disabled={logoBusy} onClick={() => fileRef.current?.click()}>
                    {logoBusy ? <IconSpinner size={16} /> : <IconUpload size={16} />}
                    {badge.ownLogo ? "Replace logo" : "Upload your logo"}
                  </button>
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,image/svg+xml"
                    hidden
                    onChange={(e) => {
                      void uploadLogo(e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </div>
                <p className="badge-logo-note" data-error={logoError ? "" : undefined} role={logoError ? "alert" : undefined}>
                  {logoError ?? "PNG, JPG or SVG. It goes on your badge, above your name."}
                  {badge.ownLogo && !logoError && (
                    <>
                      {" "}
                      <button type="button" className="link" disabled={logoBusy} onClick={removeLogo}>
                        Remove it
                      </button>
                    </>
                  )}
                </p>
              </div>
            </div>

            <div className="badge-share">
              <span className="label">Share your badge</span>
              {/* one row: the main way to share with its name on it, the rest as square icons */}
              <div className="badge-share-row">
                <a className="gate-cta quiet badge-share-main" href={`https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(`${text} ${shareUrl}`)}`} target="_blank" rel="noopener noreferrer" onClick={() => void flush()}>
                  <IconLinkedIn size={16} />
                  Share on LinkedIn
                </a>
                <span className="badge-share-icon" data-tip="Post on X">
                  <a className="gate-cta quiet" aria-label="Post on X" href={`https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`} target="_blank" rel="noopener noreferrer" onClick={() => void flush()}>
                    <IconXSocial size={16} />
                  </a>
                </span>
                <span className="badge-share-icon" data-tip={copied ? "Copied" : "Copy link"}>
                  <button type="button" className="gate-cta quiet" aria-label="Copy link" onClick={copy}>
                    {copied ? <IconCheck size={16} /> : <IconCopy size={16} />}
                  </button>
                </span>
                <span className="badge-share-icon" data-tip="Download image">
                  <a className="gate-cta quiet" aria-label="Download image" href={`/api/waitlist/badge/${badge.slug}/image?download=1&v=${encodeURIComponent(badge.updatedAt)}`} download={`ragis-badge-${badge.number}.png`} onClick={() => void flush()}>
                    <IconDownload size={16} />
                  </a>
                </span>
              </div>
              <p className="badge-save" aria-live="polite">
                {save === "saving" ? "Saving…" : save === "saved" ? "Saved. Your link shows the latest version." : save === "error" ? "Couldn't save the last change. Try again." : "Changes save on their own."}
              </p>
            </div>
          </>
        ) : (
          guest
        )}
      </div>
    </div>
  );
}
