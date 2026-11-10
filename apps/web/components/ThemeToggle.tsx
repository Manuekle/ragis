"use client";

import { useEffect, useState } from "react";
import { IconMoon, IconSun, IconSunMoon } from "./icons";

export type Theme = "light" | "system" | "dark";

const KEY = "ragsis:theme";

const OPTIONS: { value: Theme; label: string; Icon: typeof IconSun }[] = [
  { value: "light", label: "Light theme", Icon: IconSun },
  { value: "system", label: "System theme", Icon: IconSunMoon },
  { value: "dark", label: "Dark theme", Icon: IconMoon },
];

function stored(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => setTheme(stored()), []);

  const pick = (value: Theme) => {
    setTheme(value);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
    if (reduce) return apply(value);
    if (doc.startViewTransition) {
      // Crossfade the whole page between the old and new theme snapshot.
      doc.startViewTransition(() => apply(value));
      return;
    }
    // Fallback: briefly transition colors on every element.
    const root = document.documentElement;
    root.classList.add("theme-fading");
    apply(value);
    window.setTimeout(() => root.classList.remove("theme-fading"), 500);
  };

  return (
    <div className="theme-toggle" role="group" aria-label="Appearance">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={value}
          type="button"
          className="theme-option"
          aria-label={label}
          aria-pressed={theme === value}
          data-tip={label}
          onClick={() => pick(value)}
        >
          <Icon size={15} />
        </button>
      ))}
    </div>
  );
}
