"use client";

import { usePathname } from "next/navigation";
import { LOCALES, localePath, splitLocale, type Locale } from "@/lib/i18n";
import { useLocale } from "./LocaleProvider";

const LABEL: Record<Locale, { short: string; name: string }> = {
  en: { short: "EN", name: "Read in English" },
  es: { short: "ES", name: "Leer en español" },
};

/**
 * English | Spanish toggle for the header and footer of the public pages. Each side links to the
 * same page in its language (/pricing and /es/pricing); the query string and hash come along, so a
 * `?season=` preview or an anchor survives the switch.
 *
 * Switching is a full page load on purpose: the language lives in the root layout (<html lang>, the
 * provider client components read), and Next keeps a layout mounted across soft navigations, so a
 * client-side hop would leave the new page's text in one language and the shell in the other.
 */
export function LanguageSwitch() {
  const locale = useLocale();
  const { path } = splitLocale(usePathname());

  return (
    <div className="lang-toggle" role="group" aria-label={locale === "es" ? "Idioma" : "Language"}>
      {LOCALES.map((l) => {
        const href = localePath(l, path);
        return (
          <a
            key={l}
            href={href}
            lang={l}
            hrefLang={l}
            className="lang-option"
            aria-label={LABEL[l].name}
            aria-current={l === locale ? "true" : undefined}
            data-tip={LABEL[l].name}
            onClick={(e) => {
              e.preventDefault();
              if (l === locale) return;
              const { search, hash } = window.location;
              window.location.assign(`${href}${search}${hash}`);
            }}
          >
            {LABEL[l].short}
          </a>
        );
      })}
    </div>
  );
}
