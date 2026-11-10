"use client";

import { useEffect, useRef, useState } from "react";

const runtimeUrl = new URL("mermaid/dist/mermaid.min.js", import.meta.url).href;

type DiagramSize = { width: number; height: number };

function diagramDocument(source: string, isDark: boolean) {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  // Escape script end tags in uploaded content before embedding the JSON in srcdoc.
  const diagram = JSON.stringify(source).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="color-scheme" content="${isDark ? "dark" : "light"}">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'">
<style>
  body { margin: 0; }
  svg { display: block; height: auto; margin: auto; }
</style>
<body>
<main></main>
<script nonce="${nonce}" src="${runtimeUrl}"></script>
<script nonce="${nonce}">
  (async () => {
    const container = document.querySelector('main');
    try {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: ${JSON.stringify(isDark ? "dark" : "default")},
      });
      // The browser can pause layout when this sandbox scrolls out of view.
      let width = 0;
      let height = 0;
      do {
        await new Promise(requestAnimationFrame);
        const { svg } = await mermaid.render('diagram', ${diagram}, container);
        container.innerHTML = svg;
        const diagram = container.querySelector('svg');
        width = Math.ceil(diagram.viewBox.baseVal.width || diagram.getBoundingClientRect().width);
        diagram.style.width = width + 'px';
        height = Math.ceil(diagram.getBoundingClientRect().height);
      } while (!width || !height);
      parent.postMessage({ mermaidSize: { width, height } }, '*');
    } catch {
      parent.postMessage({ mermaidSize: null }, '*');
    }
  })();
</script>
</body>
</html>`;
}

export default function MermaidBlock({ source, isDark }: { source: string; isDark: boolean }) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState<DiagramSize | null>();

  useEffect(() => {
    const frame = iframe.current;
    if (!frame) return;

    let started = false;
    let timeout: number | undefined;
    const visibility = new IntersectionObserver(([entry]) => {
      window.clearTimeout(timeout);
      if (!entry.isIntersecting) return;
      if (!started) {
        started = true;
        frame.srcdoc = diagramDocument(source, isDark);
      }
      timeout = window.setTimeout(() => finish(null), 20_000);
    });

    function finish(nextSize: DiagramSize | null) {
      visibility.disconnect();
      window.clearTimeout(timeout);
      setSize(nextSize);
    }

    function onMessage(event: MessageEvent<{ mermaidSize?: DiagramSize | null }>) {
      if (event.source !== frame?.contentWindow) return;
      const nextSize = event.data?.mermaidSize;
      if (nextSize !== null && (
        !nextSize || !Number.isFinite(nextSize.width) || nextSize.width <= 0 ||
        !Number.isFinite(nextSize.height) || nextSize.height <= 0
      )) return;
      finish(nextSize);
    }

    window.addEventListener("message", onMessage);
    visibility.observe(frame);
    return () => {
      visibility.disconnect();
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timeout);
    };
  }, [source, isDark]);

  if (size === null) {
    return (
      <>
        <p className="faint">Couldn&apos;t render this Mermaid diagram.</p>
        <pre><code className="language-mermaid">{source}</code></pre>
      </>
    );
  }

  return (
    <>
      {!size && <p className="faint" role="status">Rendering Mermaid diagram…</p>}
      <div className="viewer-mermaid-scroll" role="region" aria-label="Mermaid diagram" tabIndex={size ? 0 : undefined}>
        <iframe
          ref={iframe}
          className="viewer-mermaid"
          title="Mermaid diagram"
          sandbox="allow-scripts"
          tabIndex={-1}
          aria-hidden={!size}
          style={{ height: size?.height ?? 96, minWidth: size?.width }}
        />
      </div>
    </>
  );
}
