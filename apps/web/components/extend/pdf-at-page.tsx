"use client";

import { useCallback, useEffect, useRef } from "react";
import { PDFViewer, type PDFViewerHandle, type PDFViewerProps } from "./pdf-viewer";

/**
 * The PDF viewer opened at a page (a cited passage, the page a deadline comes from). The scroll plugin settles a
 * moment after the document loads, so the jump is repeated once shortly after; nothing moves after that, so the
 * reader's own scrolling is never fought.
 */
export function PDFViewerAtPage({ page, onDocumentLoadSuccess, ...props }: PDFViewerProps & { page?: number }) {
  const ref = useRef<PDFViewerHandle>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const onLoad = useCallback(
    (numPages: number) => {
      onDocumentLoadSuccess?.(numPages);
      if (!page || page < 2 || page > numPages) return;
      for (const ms of [150, 600]) timers.current.push(window.setTimeout(() => ref.current?.scrollToPage(page), ms));
    },
    [page, onDocumentLoadSuccess],
  );
  return <PDFViewer ref={ref} {...props} onDocumentLoadSuccess={onLoad} />;
}
