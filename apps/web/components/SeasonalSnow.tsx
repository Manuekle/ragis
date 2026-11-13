"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

// WebGL runs only in the browser, and the snow ships only when lib/season.ts turns it on.
const PixelSnow = dynamic(() => import("./PixelSnow"), { ssr: false });

/** Follows the site theme: an explicit data-theme on <html>, else the system preference. */
function useDarkTheme() {
  const [dark, setDark] = useState<boolean | null>(null);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const read = () => setDark(root.dataset.theme ? root.dataset.theme === "dark" : media.matches);
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    media.addEventListener("change", read);
    return () => {
      observer.disconnect();
      media.removeEventListener("change", read);
    };
  }, []);
  return dark;
}

/**
 * Pixel snow for the winter holidays, over the hero's and the wall's dither horizon and under their copy
 * (.gate-snow); it drifts into a pile along the section's bottom edge. White on dark, brand blue on
 * light, where white flakes would vanish.
 */
export function SeasonalSnow() {
  const dark = useDarkTheme();
  return (
    <div className="gate-snow" aria-hidden="true">
      {dark !== null && <PixelSnow color={dark ? "#ffffff" : "#5aa6ff"} lightMode={!dark} density={0.16} speed={0.7} wind={0.2} flakeSize={0.75} pixelSize={3} glow={dark ? 0.8 : 0.3} accumulate />}
    </div>
  );
}
