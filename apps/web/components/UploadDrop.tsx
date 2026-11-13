"use client";

import { FileTile } from "@/components/FileTile";
import { IconTrash, IconX } from "@/components/icons";
import { formatBytes } from "@/lib/api";

/**
 * The brand folder (same paths and colours as FolderGlyph) with two sheets tucked between the
 * back and front panels. At rest it looks exactly like the glyph; hover lets the sheets peek out
 * and `open` (a file is being dragged over) lifts them out of the folder.
 */
export function FolderDrop({ size = 64, open = false }: { size?: number; open?: boolean }) {
  return (
    <span className={`fdrop${open ? " is-open" : ""}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 67 67" width={size} height={size} fill="none" focusable="false">
        {/* Back panel and tab: the brand glyph, untouched. */}
        <path d="M11.17 15.35v15.36h44.67v-6.98c0-3.86-3.13-6.98-6.98-6.98H33.5l-3.93-5.89a5.58 5.58 0 0 0-4.64-2.49h-6.78c-3.86 0-6.98 3.13-6.98 6.98Z" fill="#00A1FF" />
        <path d="M33.5 16.75l-3.93-5.89a5.58 5.58 0 0 0-4.64-2.49h-6.78c-3.86 0-6.98 3.13-6.98 6.98v15.36h44.67v-6.98c0-3.86-3.13-6.98-6.98-6.98H33.5Zm0 0h-9.77" stroke="#00A1FF" strokeWidth="4.19" strokeLinecap="round" strokeLinejoin="round" />
        {/* Sheets hidden behind the front panel; they only rise into view on hover and drag. */}
        <g className="fdrop-papers">
          <rect className="fdrop-paper p1" x="17" y="19" width="28" height="22" rx="2.5" />
          <rect className="fdrop-paper p2" x="22" y="17" width="28" height="22" rx="2.5" />
        </g>
        {/* Front panel: the brand glyph, untouched and never transformed. */}
        <path d="M6.59 42.38c-1.05-5.26-1.57-7.89-.08-9.67l.31-.34c1.66-1.66 4.59-1.66 10.45-1.66h32.46c5.86 0 8.79 0 10.45 1.66l.31.34c1.49 1.78.97 4.41-.08 9.67-1.51 7.56-2.26 11.34-5.1 13.66l-.6.46c-3.01 2.13-7.23 2.13-15.66 2.13h-11.1c-8.43 0-12.64 0-15.66-2.13l-.6-.46c-2.84-2.32-3.6-6.1-5.1-13.66Z" fill="#3CC7FF" stroke="#3CC7FF" strokeWidth="4.19" />
      </svg>
    </span>
  );
}

export type UploadPhase = "uploading" | "indexing" | "ready" | "failed";

export interface UploadItem {
  key: string;
  name: string;
  size: number;
  ext: string;
  phase: UploadPhase;
  /** Pipeline step the file is on (0 upload · 1 safety check · 2 read · 3 index); kept on failure to show where it stopped. */
  stage: number;
  /** 0–1 while the bytes go up. */
  progress: number;
  error?: string;
  /** Set once the server accepted the file; the listing then reports its indexing status. */
  docId?: string;
  /** Object URL for image files, so the row shows the picture itself. */
  preview?: string;
  leaving?: boolean;
}

type Kind = "pdf" | "doc" | "slides" | "sheet" | "image" | "audio";
const KIND: Record<string, Kind> = {
  pdf: "pdf",
  pptx: "slides",
  xlsx: "sheet",
  csv: "sheet",
  png: "image",
  jpg: "image",
  jpeg: "image",
  mp3: "audio",
  wav: "audio",
  m4a: "audio",
  ogg: "audio",
  flac: "audio",
};
const kindOf = (ext: string): Kind => KIND[ext] ?? "doc";

/** What "reading" means for each kind of file: the worker runs a different extractor for each. */
const READ: Record<Kind, { now: string; short: string }> = {
  pdf: { now: "Reading the pages", short: "Read pages" },
  doc: { now: "Reading the text", short: "Read text" },
  slides: { now: "Reading the slides", short: "Read slides" },
  sheet: { now: "Reading the tables", short: "Read tables" },
  image: { now: "Looking for text in the image", short: "Read image" },
  audio: { now: "Turning speech into text", short: "Transcribe" },
};

function stages(kind: Kind) {
  return [
    { now: "Uploading", short: "Upload" },
    { now: "Checking the file is safe", short: "Safety check" },
    READ[kind],
    { now: kind === "audio" ? "Indexing the transcript" : "Indexing for search", short: "Index" },
  ];
}

/** Server status → pipeline step. */
export function stageOf(status: string): number {
  if (status === "pending_upload") return 0;
  if (status === "uploaded" || status === "quarantined") return 1;
  if (status === "validated" || status === "parsing") return 2;
  return 3; // enriched, embedding, indexed
}

/** Done: a green disc with a check that draws itself. Failed: a red disc with "!". Working: a quiet spinner. */
function StateMark({ phase }: { phase: UploadPhase }) {
  return (
    <span className={`umark is-${phase}`} aria-hidden="true">
      <svg viewBox="0 0 24 24" width="22" height="22" fill="none">
        {phase === "ready" ? (
          <>
            <circle className="umark-disc" cx="12" cy="12" r="11" />
            <path className="umark-draw" d="M7.5 12.4l3 3 6-6.4" />
          </>
        ) : phase === "failed" ? (
          <>
            <circle className="umark-disc" cx="12" cy="12" r="11" />
            <path className="umark-draw" d="M12 7v6" />
            <circle className="umark-dot" cx="12" cy="16.6" r="1.25" />
          </>
        ) : (
          <>
            <circle className="umark-track" cx="12" cy="12" r="9" />
            <circle className="umark-arc" cx="12" cy="12" r="9" pathLength="100" />
          </>
        )}
      </svg>
    </span>
  );
}

export function UploadTracker({ items, onDismiss, onRemove }: { items: UploadItem[]; onDismiss: (key: string) => void; onRemove: (it: UploadItem) => void }) {
  const shown = items.filter((i) => !i.leaving);
  if (!items.length) return null;
  const ready = shown.filter((i) => i.phase === "ready").length;
  const failed = shown.filter((i) => i.phase === "failed").length;
  const active = shown.length - ready - failed;
  const plural = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
  const title = active
    ? `Adding ${plural(active)}`
    : failed && !ready
      ? `Couldn't add ${plural(failed)}`
      : failed
        ? `${ready} indexed · ${failed} couldn't be added`
        : `${ready === 1 ? "File" : `All ${ready} files`} indexed`;
  const tone = active ? "active" : failed ? "failed" : "ready";
  return (
    <section className={`utrack is-${tone}`} aria-label="Uploads">
      <header className="utrack-head">
        <span className="utrack-title" key={title}>
          {title}
        </span>
        {active > 0 && (
          <span className="utrack-count">
            {ready} of {shown.length - failed} indexed
          </span>
        )}
      </header>
      <ul className="utrack-list" aria-live="polite">
        {items.map((it) => (
          <UploadRow key={it.key} it={it} onDismiss={onDismiss} onRemove={onRemove} />
        ))}
      </ul>
    </section>
  );
}

function UploadRow({ it, onDismiss, onRemove }: { it: UploadItem; onDismiss: (key: string) => void; onRemove: (it: UploadItem) => void }) {
  const kind = kindOf(it.ext);
  const steps = stages(kind);
  const current = steps[Math.min(it.stage, steps.length - 1)];
  const label =
    it.phase === "ready"
      ? "Indexed · ready for questions"
      : it.phase === "failed"
        ? it.error ?? "Couldn't add this file"
        : it.phase === "uploading" && it.progress === 0
          ? "Waiting to upload"
          : current.now;
  const right = it.phase === "uploading" && it.progress > 0 ? `${Math.round(it.progress * 100)}%` : it.phase === "indexing" ? `${it.stage + 1}/${steps.length}` : null;
  return (
    <li className={`urow is-${it.phase}${it.leaving ? " is-leaving" : ""}`}>
      <span className={`urow-thumb${it.preview ? " has-img" : ""}`}>
        {it.preview ? (
          // eslint-disable-next-line @next/next/no-img-element -- local object URL, not an optimisable asset
          <img src={it.preview} alt="" />
        ) : (
          <FileTile ext={it.ext} size={36} />
        )}
      </span>
      <span className="urow-body">
        <span className="urow-top">
          <span className="urow-name" title={it.name}>
            {it.name}
          </span>
          <span className="urow-size">{formatBytes(it.size)}</span>
          {right && <span className="urow-pct">{right}</span>}
        </span>
        <span className="urow-segs" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={it.phase === "ready" ? steps.length : it.stage}>
          {steps.map((s, i) => {
            const state = it.phase === "ready" || i < it.stage ? "done" : i === it.stage ? (it.phase === "failed" ? "fail" : "now") : "todo";
            const fill = state === "done" || state === "fail" ? 1 : state === "now" && i === 0 ? it.progress : 0;
            return (
              <span key={s.short} className={`useg is-${state}`} title={s.short} style={{ "--i": i } as React.CSSProperties}>
                <span className="useg-fill" style={{ transform: `scaleX(${fill})` }} />
              </span>
            );
          })}
        </span>
        <span className="urow-label" key={label}>
          {it.phase === "indexing" || (it.phase === "uploading" && it.progress > 0) ? (
            <span className="t-shimmer" data-text={label}>
              {label}
            </span>
          ) : (
            label
          )}
        </span>
      </span>
      <StateMark phase={it.phase} />
      <span className="urow-actions">
        {it.phase === "failed" && it.docId && (
          <button type="button" className="quiet icon small" onClick={() => onRemove(it)} aria-label={`Delete ${it.name}`} title="Delete file">
            <IconTrash size={14} />
          </button>
        )}
        {(it.phase === "failed" || it.phase === "indexing") && (
          <button type="button" className="quiet icon small" onClick={() => onDismiss(it.key)} aria-label={`Hide ${it.name}`} title="Hide">
            <IconX size={14} />
          </button>
        )}
      </span>
    </li>
  );
}
