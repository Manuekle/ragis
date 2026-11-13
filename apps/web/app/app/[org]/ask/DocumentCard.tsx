"use client";

import { useState } from "react";
import { generatedFileUrl, type DocFormat, type GeneratedDocument } from "@/lib/api";
import { FileTile } from "@/components/FileTile";
import { IconChat, IconCheck, IconChevronDown, IconDownload, IconEye, IconFile, IconSpinner } from "@/components/icons";
import { useDropdown } from "@/components/motion";
import { CommandGroup, CommandItem, ComposerMenu, useComposerMenu } from "./ComposerMenu";

/** What each format is called on screen (plain words, no extensions in the main copy). */
export const FORMAT: Record<DocFormat, { name: string; short: string; hint: string }> = {
  pdf: { name: "PDF report", short: "PDF", hint: "Formatted and ready to share" },
  docx: { name: "Word document", short: "Word", hint: "Edit it in Word or Google Docs" },
  pptx: { name: "PowerPoint presentation", short: "PowerPoint", hint: "Slides ready to present" },
  xlsx: { name: "Excel workbook", short: "Excel", hint: "Sheets with filters, ready to sort and sum" },
  csv: { name: "CSV file", short: "CSV", hint: "Plain table for any app or import" },
  md: { name: "Markdown", short: "Markdown", hint: "Plain text with formatting marks" },
};

/** Formats offered in the composer ("Answer as…"). CSV and Markdown stay download options only. */
export const PICKABLE: DocFormat[] = ["pdf", "docx", "pptx", "xlsx"];

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function stats(d: GeneratedDocument): string {
  const parts = [FORMAT[d.format].name];
  if (d.format === "pptx" && d.slides) parts.push(plural(d.slides, "slide", "slides"));
  else if ((d.format === "xlsx" || d.format === "csv") && d.rows) parts.push(plural(d.rows, "row", "rows"));
  else if (d.sections) parts.push(plural(d.sections, "section", "sections"));
  // Distinct documents, not passages: six citations of one policy read as "1 document" (older cards lack the field).
  parts.push(d.documents ? plural(d.documents, "document", "documents") : plural(d.sources, "source", "sources"));
  return parts.join(" · ");
}

/** Fetches the file through the BFF and saves it; errors (e.g. a source the person can no longer open) come back as text. */
export async function downloadGenerated(org: string, id: string, format: DocFormat): Promise<void> {
  const res = await fetch(generatedFileUrl(org, id, format));
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new Error(data?.error?.message ?? "Couldn't download the file. Try again in a moment.");
  }
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `document.${format}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function DocumentCard({ doc, orgId, onPreview }: { doc: GeneratedDocument; orgId: string; onPreview: (d: GeneratedDocument) => void }) {
  const more = useDropdown();
  const [busy, setBusy] = useState<DocFormat | null>(null);
  const [done, setDone] = useState<DocFormat | null>(null);
  const [error, setError] = useState<string | null>(null);
  const others = (doc.formats?.length ? doc.formats : (["pdf", "docx", "pptx", "xlsx", "csv", "md"] as DocFormat[])).filter((f) => f !== doc.format);

  async function get(format: DocFormat) {
    if (busy) return;
    more.close();
    setBusy(format);
    setError(null);
    try {
      await downloadGenerated(orgId, doc.id, format);
      setDone(format);
      setTimeout(() => setDone((x) => (x === format ? null : x)), 2200);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="gen-doc" data-format={doc.format}>
      <div className="gen-doc-head">
        <FileTile ext={doc.format} size={46} />
        <div className="gen-doc-text">
          <strong className="gen-doc-title">{doc.title}</strong>
          <span className="gen-doc-meta">{stats(doc)}</span>
        </div>
      </div>

      {doc.outline.length > 0 && (
        <ol className="gen-doc-outline" aria-label="Contents">
          {doc.outline.slice(0, 6).map((s, i) => (
            <li key={`${i}-${s}`}>
              <span className="num">{i + 1}</span>
              <span className="txt">{s}</span>
            </li>
          ))}
          {doc.outline.length > 6 && <li className="more">+{doc.outline.length - 6} more</li>}
        </ol>
      )}

      <div className="gen-doc-actions">
        <button type="button" className="primary small" onClick={() => get(doc.format)} disabled={!!busy} aria-busy={busy === doc.format}>
          {busy === doc.format ? <IconSpinner size={14} /> : done === doc.format ? <IconCheck size={15} /> : <IconDownload size={15} />}
          Download {FORMAT[doc.format].short}
        </button>
        <button type="button" className="ghost small" onClick={() => onPreview(doc)}>
          <IconEye size={15} />
          Preview
        </button>
        <div className="gen-doc-more" ref={more.ref}>
          <button type="button" className="quiet small" aria-haspopup="menu" aria-expanded={more.isOpen} onClick={more.toggle} disabled={!!busy && busy !== doc.format}>
            {busy && busy !== doc.format ? <IconSpinner size={14} /> : null}
            Other formats
            <IconChevronDown size={14} />
          </button>
          <div className={`menu ${more.cls}`} role="menu" data-origin="top-left" inert={!more.isOpen}>
            <div className="menu-label">Download as</div>
            {others.map((f) => (
              <button key={f} type="button" role="menuitem" className="menu-item gen-doc-fmt" onClick={() => get(f)}>
                <FileTile ext={f} size={22} />
                <span className="lbl">
                  <span>{FORMAT[f].name}</span>
                  <span className="hint">{FORMAT[f].hint}</span>
                </span>
                {done === f && <IconCheck className="check" size={15} />}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && (
        <p className="gen-doc-error" role="alert">
          {error}
        </p>
      )}
      <p className="gen-doc-note">
        <IconFile size={13} />
        Written by AI using only your documents. Each fact cites its source, listed at the end of the file.
      </p>
    </div>
  );
}

/** "Answer as…" chip in the composer: chat answer (default) or a file in one of the formats. */
export function FormatPicker({ value, onChange, disabled }: { value: DocFormat | null; onChange: (v: DocFormat | null) => void; disabled?: boolean }) {
  const state = useComposerMenu();
  const { menu, onTriggerKey } = state;
  const pick = (v: DocFormat | null) => {
    onChange(v);
    menu.close();
  };
  return (
    <div className="cmenu-host" ref={menu.ref}>
      <span className={`date-chip fmt-chip${value ? " is-set" : ""}`} data-tip={value || menu.isOpen ? undefined : "Get the answer as a file: PDF, Word, PowerPoint or Excel"}>
        <button type="button" className="date-trigger" aria-haspopup="menu" aria-expanded={menu.isOpen} onClick={menu.toggle} onKeyDown={onTriggerKey} disabled={disabled}>
          {value ? <FileTile ext={value} size={16} /> : <IconChat size={15} />}
          Answer as
          <span className="date-value">{value ? FORMAT[value].short : "chat"}</span>
          <IconChevronDown size={13} />
        </button>
      </span>
      <ComposerMenu state={state} label="Answer as" footer="You can also ask for a file in your own words: “make a PowerPoint about…”.">
        <CommandGroup>
          <CommandItem icon={<IconChat size={16} />} title="Chat answer" hint="Here, with sources" checked={value === null} onClick={() => pick(null)} />
          {PICKABLE.map((f) => (
            <CommandItem key={f} bare icon={<FileTile ext={f} size={26} />} title={FORMAT[f].name} hint={FORMAT[f].hint} checked={value === f} onClick={() => pick(f)} />
          ))}
        </CommandGroup>
      </ComposerMenu>
    </div>
  );
}
