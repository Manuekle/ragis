"use client";

import { useMemo } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import MermaidBlock from "./MermaidBlock";

/** Markdown preview. Raw HTML is never rendered (react-markdown default), links open in a new tab and remote images are not fetched. */
export default function MarkdownView({ source, isDark }: { source: string; isDark: boolean }) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ),
    img: ({ alt }) => <span className="faint">[{alt || "image"}]</span>,
    pre: ({ node, children, ...props }) => {
      const code = node?.children[0];
      if (
        code?.type === "element" && code.tagName === "code" &&
        Array.isArray(code.properties.className) &&
        code.properties.className.some((name) => String(name).toLowerCase() === "language-mermaid")
      ) {
        const diagram = code.children[0];
        if (diagram?.type === "text") {
          return <MermaidBlock key={diagram.value} source={diagram.value} isDark={isDark} />;
        }
      }
      return <pre {...props}>{children}</pre>;
    },
  }), [isDark]);

  return (
    <div className="viewer-md-scroll">
      <article className="viewer-md">
        <Markdown remarkPlugins={[remarkGfm]} components={components}>
          {source}
        </Markdown>
      </article>
    </div>
  );
}
