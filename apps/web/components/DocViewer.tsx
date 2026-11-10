"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { api } from "@/lib/api";
import { FileTile } from "./FileTile";
import { IconAlert, IconSpinner, IconX } from "./icons";
import { Button } from "./vui/button";
import { TooltipProvider } from "./vui/tooltip";
import { ViewerBarFallback, ViewerChromeContext } from "./extend/viewer-chrome";
import "@/app/viewer.css";

// Extend UI viewers (shadcn, themed with the app tokens in app/viewer.css). Browser-only and heavy: loaded per file type, on demand.
const Loading = () => (
  <Stage>
    <IconSpinner size={20} />
  </Stage>
);

/** A screen without a viewer toolbar (loading, errors, images, plain text): same single bar, built by hand. */
function Stage({ children, note = true }: { children: React.ReactNode; note?: boolean }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ViewerBarFallback />
      <div className={note ? "viewer-note" : "grid min-h-0 flex-1"}>{children}</div>
    </div>
  );
}
const PDFViewer = dynamic(() => import("./extend/pdf-viewer").then((m) => m.PDFViewer), { ssr: false, loading: Loading });
const DocxViewerPreview = dynamic(() => import("./extend/docx-viewer").then((m) => m.DocxViewerPreview), { ssr: false, loading: Loading });
const XlsxViewerPreview = dynamic(() => import("./extend/xlsx-viewer").then((m) => m.XlsxViewerPreview), { ssr: false, loading: Loading });
const PptxViewerPreview = dynamic(() => import("./extend/pptx-viewer").then((m) => m.PptxViewerPreview), { ssr: false, loading: Loading });
// Markdown already sits inside a Stage, which keeps the toolbar visible while the chunk loads.
const MarkdownView = dynamic(() => import("./MarkdownView"), {
  ssr: false,
  loading: () => <div className="viewer-note"><IconSpinner size={20} /></div>,
});
const CsvViewer = dynamic(() => import("./extend/csv-viewer").then((m) => m.CsvViewer), { ssr: false, loading: Loading });

/** The app's theme: <html data-theme> when the user picked one, else the OS preference. */
function subscribeTheme(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", cb);
  return () => {
    mo.disconnect();
    mq.removeEventListener("change", cb);
  };
}
const readDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
};
function useAppDark() {
  const appDark = useSyncExternalStore(subscribeTheme, readDark, () => false);
  // DOCX/XLSX have their own "night render" toggle: start from the app theme, follow it when it changes.
  const [dark, setDark] = useState(appDark);
  useEffect(() => setDark(appDark), [appDark]);
  return { appDark, dark, setDark };
}

export interface ViewerDoc {
  documentId: string;
  versionId: string;
  title: string;
  filename: string;
}

type Kind = "pdf" | "docx" | "xlsx" | "pptx" | "csv" | "md" | "image" | "text" | "none";

const ext = (f: string) => f.split(".").pop()?.toLowerCase() ?? "";
function kindOf(filename: string): Kind {
  const e = ext(filename);
  if (e === "pdf" || e === "docx" || e === "xlsx" || e === "pptx" || e === "csv") return e;
  if (["png", "jpg", "jpeg"].includes(e)) return "image";
  if (e === "md" || e === "markdown") return "md";
  if (["txt", "html", "htm"].includes(e)) return "text";
  return "none";
}

const CLOSE_MS = 180;

/** Full-screen document viewer. The file is shown inline from a short-lived presigned URL; it is never downloaded unless the user asks. */
export function DocViewer({ doc, orgId, onClose }: { doc: ViewerDoc | null; orgId: string; onClose: () => void }) {
  const [current, setCurrent] = useState<ViewerDoc | null>(null);
  const [shown, setShown] = useState(false);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [body, setBody] = useState<string | null>(null);
  const { appDark, dark, setDark } = useAppDark();
  const restore = useRef<HTMLElement | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);

  // Mount on open, keep rendering during the exit transition.
  useEffect(() => {
    if (doc) {
      restore.current = document.activeElement as HTMLElement | null;
      setCurrent(doc);
      setUrl(null);
      setBody(null);
      setError(null);
      const raf = requestAnimationFrame(() => {
        setShown(true);
        layerRef.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
      });
      return () => cancelAnimationFrame(raf);
    }
    setShown(false);
    const t = setTimeout(() => {
      setCurrent(null);
      restore.current?.focus?.();
    }, CLOSE_MS);
    return () => clearTimeout(t);
  }, [doc]);

  // Inline presigned URL (only for types the browser can render).
  useEffect(() => {
    if (!doc || kindOf(doc.filename) === "none") return;
    let live = true;
    api<{ url: string }>(`organizations/${orgId}/documents/${doc.documentId}/versions/${doc.versionId}/download?disposition=inline`)
      .then(async (r) => {
        const k = kindOf(doc.filename);
        if (k === "csv" || k === "text" || k === "md") {
          const res = await fetch(r.url);
          if (!res.ok) throw new Error(`Couldn't read the file (${res.status})`);
          const text = await res.text();
          if (live) setBody(text);
        }
        if (live) setUrl(r.url);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [doc, orgId]);

  // Esc closes; Tab stays inside the viewer; page behind doesn't scroll.
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && layerRef.current) {
        const f = Array.from(layerRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), .viewer-mermaid-scroll[tabindex='0']"));
        if (!f.length) return;
        const i = f.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
      }
    };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      document.removeEventListener("keydown", onKey);
    };
  }, [current, onClose]);

  const download = useCallback(async () => {
    if (!current) return;
    setDownloading(true);
    try {
      const r = await api<{ url: string }>(`organizations/${orgId}/documents/${current.documentId}/versions/${current.versionId}/download`);
      window.location.assign(r.url); // attachment disposition: saves the file, page stays put
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloading(false);
    }
  }, [current, orgId]);

  if (!current || typeof document === "undefined") return null;
  const kind = kindOf(current.filename);

  const lead = (
    <div className="flex min-w-0 items-center gap-2.5 pr-2">
      <FileTile ext={ext(current.filename)} size={28} />
      <div className="flex min-w-0 flex-col leading-tight">
        <strong className="max-w-[26ch] truncate text-sm font-medium">{current.title}</strong>
        <span className="mono max-w-[26ch] truncate text-muted-foreground">{current.filename}</span>
      </div>
    </div>
  );
  const actions = (
    <>
      <Button type="button" variant="outline" size="sm" onClick={download} disabled={downloading}>
        {downloading ? <IconSpinner size={14} /> : null}
        Download
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" className="order-last ml-1" data-autofocus onClick={onClose} aria-label="Close preview">
        <IconX size={18} />
      </Button>
    </>
  );
  const cp = { src: url ?? undefined, fileName: current.filename, showUpload: false, showDownload: false, toolbarActions: actions, className: "h-full" };

  return createPortal(
    <ViewerChromeContext.Provider value={{ lead, actions }}>
      <div ref={layerRef} className={`xui viewer-layer${shown ? " is-open" : ""}`} role="dialog" aria-modal="true" aria-label={current.title}>
        <div className="viewer-body">
          {error ? (
            <Stage>
              <IconAlert size={20} />
              <strong>Couldn't open the document</strong>
              <span>{error}</span>
            </Stage>
          ) : kind === "none" ? (
            <Stage>
              <FileTile ext={ext(current.filename)} size={56} />
              <strong>No preview for this file type</strong>
              <span>Download it to open it in its app.</span>
            </Stage>
          ) : !url || ((kind === "csv" || kind === "text" || kind === "md") && body === null) ? (
            <Stage>
              <IconSpinner size={20} />
            </Stage>
          ) : kind === "image" ? (
            <Stage note={false}>
              {/* eslint-disable-next-line @next/next/no-img-element -- short-lived presigned URL, not optimizable */}
              <img className="viewer-img" src={url} alt={current.title} referrerPolicy="no-referrer" />
            </Stage>
          ) : kind === "md" ? (
            <Stage note={false}>
              <MarkdownView source={body ?? ""} isDark={appDark} />
            </Stage>
          ) : kind === "text" ? (
            <Stage note={false}>
              <pre className="viewer-text">{body}</pre>
            </Stage>
          ) : (
            <TooltipProvider>
              {kind === "pdf" && <PDFViewer key={url} {...cp} />}
              {kind === "docx" && <DocxViewerPreview key={url} {...cp} isDark={dark} onIsDarkChange={setDark} />}
              {kind === "xlsx" && <XlsxViewerPreview key={url} {...cp} isDark={dark} onIsDarkChange={setDark} />}
              {kind === "pptx" && <PptxViewerPreview key={url} {...cp} />}
              {kind === "csv" && <CsvViewer key={url} data={body ?? ""} search className="h-full" />}
            </TooltipProvider>
          )}
        </div>
        {kind === "csv" && <div id="portal" className="fixed top-0 left-0 z-[130]" />}
      </div>
    </ViewerChromeContext.Provider>,
    document.body,
  );
}
