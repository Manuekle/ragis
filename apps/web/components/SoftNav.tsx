"use client";

import { usePathname } from "next/navigation";
import { useLayoutEffect, useRef } from "react";

/**
 * Marks `<html data-nav="soft">` once the visitor has moved to another page inside the app. The
 * public pages and the landing play an intro on arrival (guides drawing in, crosses popping, a
 * staggered headline); after the first page that intro would replay on every link, so CSS keyed
 * on this flag swaps it for a short settle. A layout effect, so the flag is in place before the
 * new page's first frame.
 */
export function SoftNav() {
  const pathname = usePathname();
  const first = useRef(pathname);

  useLayoutEffect(() => {
    if (pathname !== first.current) document.documentElement.dataset.nav = "soft";
  }, [pathname]);

  return null;
}
