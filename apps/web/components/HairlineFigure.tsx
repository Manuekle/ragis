"use client";

// Mounts a Hairline figure (isometric line drawing that answers the pointer).
// The kernel and the figure are static files in /public/figures: the figure is a plain script that
// calls the global `hairline(...)`, so it is loaded once and its definition captured here.
import { useEffect, useRef } from "react";

interface Figure {
  name: string;
  means: string;
  range: [number, number, number];
  mount(env: { stage: HTMLElement; svg: SVGElement; read: { textContent: string | null } }, value: number): { destroy(): void };
}

type HairlineKernel = { inject(root: Document): void; mk(tag: string, attrs: Record<string, string>, parent: Element): SVGElement };
declare global {
  interface Window {
    HL?: HairlineKernel;
    hairline?: (figure: Figure) => void;
  }
}

const loaded = new Map<string, Promise<unknown>>();
function loadScript(src: string, type?: string) {
  let p = loaded.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      if (type) el.type = type;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`Could not load ${src}`));
      document.head.appendChild(el);
    });
    loaded.set(src, p);
  }
  return p;
}

let queue: Promise<unknown> = Promise.resolve();
const figures = new Map<string, Promise<Figure>>();
function loadFigure(name: string): Promise<Figure> {
  const cached = figures.get(name);
  if (cached) return cached;
  // One at a time: the figure announces itself through a single global.
  const next = queue
    .catch(() => {})
    .then(async () => {
      await loadScript("/figures/kernel.js");
      return new Promise<Figure>((resolve, reject) => {
        window.hairline = resolve;
        loadScript(`/figures/${name}.js`, "module").catch(reject);
      });
    });
  queue = next;
  figures.set(name, next);
  return next;
}

/** `name` is a file in /public/figures. The read-out (what is under the pointer) sits below, outside the drawing. */
export function HairlineFigure({ name, label }: { name: string; label: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const readRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let handle: { destroy(): void } | undefined;
    let dead = false;

    loadFigure(name)
      .then((figure) => {
        const HL = window.HL;
        if (dead || !HL) return;
        HL.inject(document);
        const svg = HL.mk("svg", { viewBox: "0 0 400 320", "aria-hidden": "true" }, stage);
        let text: string | null = null;
        const read = {
          get textContent() {
            return text;
          },
          set textContent(value: string | null) {
            text = value == null ? "" : String(value);
            if (readRef.current) readRef.current.textContent = text;
          },
        };
        handle = figure.mount({ stage, svg, read }, figure.range[1]);
        if (text === null) read.textContent = "rest";
      })
      .catch(() => {});

    return () => {
      dead = true;
      handle?.destroy();
      stage.replaceChildren();
    };
  }, [name]);

  return (
    <figure className="hl-fig">
      <div ref={stageRef} data-hairline={name} role="img" aria-label={label} />
      <span ref={readRef} className="hl-read" aria-hidden="true" />
    </figure>
  );
}
