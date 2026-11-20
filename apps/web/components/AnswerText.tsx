"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ClipboardEvent, type CSSProperties } from "react";
import Markdown, { type Components } from "react-markdown";

/**
 * An Ask answer: the model's Markdown (bold, italics, headings, lists, line breaks) with every citation [n] as a
 * clickable chip. With `animate`, words resolve one by one through a soft cross-blur (t-stream); the total reveal is
 * capped so long answers don't drag, and chips work while it plays.
 *
 * Links, images, raw HTML and indented code are never parsed: they stay the text the model wrote, so an answer can't
 * point anywhere the sources don't. Copying puts clean HTML (real lists and bold, citations as [n]) and plain text on
 * the clipboard, so a passage pastes into a brief the way it reads here.
 */
export function AnswerText({ text, animate, onCite }: { text: string; animate: boolean; onCite: (n: number) => void }) {
  const [on, setOn] = useState(!animate);
  useEffect(() => {
    if (!animate) return;
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)));
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  // Stable for the chips, so a click that re-renders the page never remounts them (focus stays on the chip).
  const citeRef = useRef(onCite);
  useEffect(() => {
    citeRef.current = onCite;
  });
  const cite = useCallback((n: number) => citeRef.current(n), []);

  // Parsed once per answer, not on every render of the turn around it.
  const body = useMemo(
    () => (
      <Markdown remarkPlugins={[remarkSafe, [remarkAnswer, { animate }]]} allowedElements={ALLOWED} unwrapDisallowed components={COMPONENTS}>
        {restoreLines(text)}
      </Markdown>
    ),
    [text, animate],
  );

  return (
    <CiteContext value={cite}>
      <div className={`answer${on ? " is-in" : ""}`} onCopy={copyAnswer}>
        {body}
      </div>
    </CiteContext>
  );
}

/**
 * Answers saved before the verifier kept line breaks arrive on one line, each newline turned into a space. Where a run of
 * spaces after the end of a sentence (or a bold label) is followed by a list marker, a bold label or a heading, it
 * was a line break: put it back so those answers read as lists too. A wider run held the item's indent, so each
 * width is one nesting level.
 */
function restoreLines(text: string): string {
  if (text.includes("\n")) return text;
  const out = text.replace(/([.:;!?\]*]) {2,}(?=\*\*|#{1,6} )/g, "$1\n\n");
  const widths = [...new Set([...out.matchAll(LIST_GAP)].map((m) => m[2]!.length))].sort((a, b) => a - b);
  return out.replace(LIST_GAP, (_, end: string, gap: string) => `${end}\n${" ".repeat(widths.indexOf(gap.length) * 3)}`);
}
const LIST_GAP = /([.:;!?\]*])( {2,})(?=(?:[-*+]|\d{1,3}[.)]) )/g;

const CiteContext = createContext<(n: number) => void>(() => {});

function CiteChip({ className, style, "data-cite": n }: { className?: string; style?: CSSProperties; "data-cite"?: string }) {
  const onCite = useContext(CiteContext);
  return (
    <button type="button" className={className} style={style} data-cite={n} onClick={() => onCite(Number(n))} aria-label={`View source ${n}`}>
      {n}
    </button>
  );
}

// Only citations become buttons: raw HTML is never parsed, so the model can't add one.
const COMPONENTS: Components = { button: CiteChip as Components["button"] };

/** What an answer may render. Anything else is replaced by its text. */
const ALLOWED = ["p", "br", "strong", "em", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "hr", "span", "button"];

/**
 * Turns off the constructs an answer must not use: links and images (so `[3]` is always a citation and the model
 * can't invent a destination), autolinks, raw HTML, indented code (a 4-space indent stays text) and setext headings
 * (a `---` under a sentence stays a rule instead of turning the sentence into a title).
 */
function remarkSafe(this: { data(): object }) {
  const data = this.data() as { micromarkExtensions?: unknown[] };
  const extensions = (data.micromarkExtensions ??= []);
  extensions.push({
    disable: { null: ["autolink", "codeIndented", "definition", "htmlFlow", "htmlText", "labelStartImage", "labelStartLink", "setextUnderline"] },
  });
}

interface MdNode {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean | null;
  start?: number | null;
  children?: MdNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const TOKEN = /(\[\d{1,2}\]|\n|[^\S\n]+)/;
const CITE = /^\[(\d{1,2})\]$/;

/**
 * Splits every text into words (t-stream spans) and citation chips, keeps single line breaks, and moves headings two
 * levels down so an answer's `#` never competes with the page's own title.
 */
function remarkAnswer({ animate }: { animate: boolean }) {
  return (tree: MdNode) => {
    const marks: Record<string, unknown>[] = [];
    const split = (value: string): MdNode[] =>
      value
        .split(TOKEN)
        .filter(Boolean)
        .map((tok) => {
          if (tok === "\n") return { type: "break" };
          if (!tok.trim()) return { type: "text", value: tok };
          const cite = CITE.exec(tok);
          const props: Record<string, unknown> = cite ? { className: ["cite-ref", "t-stream-w"], dataCite: cite[1] } : { className: ["t-stream-w"] };
          marks.push(props);
          return { type: cite ? "cite" : "word", data: { hName: cite ? "button" : "span", hProperties: props }, children: [{ type: "text", value: cite ? cite[1] : tok }] };
        });
    const walk = (node: MdNode) => {
      if (!node.children) return;
      if (node.type === "list" && node.ordered) {
        // The item's number travels with it, so copying from the third item on still pastes "3."
        node.children.forEach((item, i) => (item.data = { hProperties: { dataN: (node.start ?? 1) + i } }));
      }
      node.children = node.children.flatMap((child): MdNode[] => {
        if (child.type === "text" || child.type === "inlineCode") return split(child.value ?? "");
        if (child.type === "code") return [{ type: "paragraph", children: split(child.value ?? "") }];
        if (child.type === "heading") child.depth = Math.min(6, (child.depth ?? 1) + 2);
        walk(child);
        return [child];
      });
    };
    walk(tree);
    if (animate) {
      const gap = Math.min(28, 1400 / (marks.length || 1));
      marks.forEach((props, i) => (props.style = `transition-delay: ${Math.round(i * gap)}ms`));
    }
  };
}

// ---------------------------------------------------------------- copy

const KEEP = new Set(["P", "BR", "STRONG", "EM", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "HR"]);
const BLOCKS = new Set(["P", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "HR"]);
// A selection inside bold or italics keeps it. A list or quote only wraps a selection it directly holds (several
// items, several paragraphs): a phrase inside one item pastes as the phrase, not as a bullet.
const WRAP_INLINE = new Set(["STRONG", "EM"]);
const WRAP_BLOCK = new Set(["UL", "OL", "BLOCKQUOTE"]);

/** Puts the selected part of the answer on the clipboard as clean HTML and plain text, citations as [n]. */
function copyAnswer(e: ClipboardEvent<HTMLDivElement>) {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return;
  const root = e.currentTarget;
  const range = selection.getRangeAt(0);
  // A selection that goes past the answer (into the question or the sources) is left to the browser.
  if (!root.contains(range.commonAncestorContainer)) return;

  let picked: Node = range.cloneContents();
  const holder = range.commonAncestorContainer;
  for (let n: Node | null = holder; n && n !== root; n = n.parentNode) {
    if (n instanceof Element && (WRAP_INLINE.has(n.tagName) || (n === holder && WRAP_BLOCK.has(n.tagName)))) {
      const wrap = n.cloneNode(false);
      wrap.appendChild(picked);
      picked = wrap;
    }
  }
  const box = document.createElement("div");
  box.append(...clean(picked));
  e.clipboardData.setData("text/html", box.innerHTML);
  e.clipboardData.setData("text/plain", plain(box).replace(/\n{3,}/g, "\n\n").trim());
  e.preventDefault();
}

/** A copy without classes, styles or the word spans; chips become [n]. */
function clean(node: Node): Node[] {
  if (node.nodeType === Node.TEXT_NODE) return [document.createTextNode(node.textContent ?? "")];
  if (node instanceof Element && node.matches(".cite-ref")) return [document.createTextNode(`[${node.getAttribute("data-cite") ?? node.textContent}]`)];
  const kids = [...node.childNodes].flatMap(clean);
  if (!(node instanceof Element) || !KEEP.has(node.tagName)) return kids;
  const el = document.createElement(node.tagName.toLowerCase());
  if (node.tagName === "OL") {
    const first = node.querySelector(":scope > li[data-n]")?.getAttribute("data-n");
    if (first && first !== "1") el.setAttribute("start", first);
  }
  el.append(...kids);
  return [el];
}

/** Plain text that reads like the answer: blank lines between paragraphs, "- " and "1. " for list items. */
function plain(node: Node, indent = ""): string {
  const parts: string[] = [];
  let line = "";
  const flush = () => {
    const lines = line
      .split("\n")
      .map((l) => l.replace(/\s+/g, " ").trim())
      .filter(Boolean);
    if (lines.length) parts.push(lines.map((l) => indent + l).join("\n"));
    line = "";
  };
  for (const child of node.childNodes) {
    if (!(child instanceof Element) || !BLOCKS.has(child.tagName)) {
      line += inline(child);
      continue;
    }
    flush();
    if (child.tagName === "UL" || child.tagName === "OL") {
      let n = Number(child.getAttribute("start")) || 1;
      const items = [...child.children].filter((li) => li.tagName === "LI");
      parts.push(
        items
          .map((li) => {
            const marker = child.tagName === "OL" ? `${n++}. ` : "- ";
            const pad = indent + " ".repeat(marker.length);
            const text = plain(li, pad);
            return indent + marker + (text.startsWith(pad) ? text.slice(pad.length) : text.trimStart());
          })
          .join("\n"),
      );
    } else if (child.tagName === "HR") {
      parts.push(indent + "———");
    } else {
      parts.push(plain(child, child.tagName === "BLOCKQUOTE" ? indent + "> " : indent));
    }
  }
  flush();
  return parts.join(node instanceof Element && node.tagName === "LI" ? "\n" : "\n\n");
}

/** Only <br> breaks a line: a newline in the markup is layout between elements. */
function inline(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\n/g, " ");
  if (!(node instanceof Element)) return "";
  if (node.tagName === "BR") return "\n";
  return [...node.childNodes].map(inline).join("");
}
