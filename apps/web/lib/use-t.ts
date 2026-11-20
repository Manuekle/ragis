"use client";

import { useCallback } from "react";
import { useLocale } from "@/components/LocaleProvider";
import { currentLocale } from "./i18n";
import { ES } from "./messages-es";

/**
 * Translator for the workspace. English is the source: the key is the English text itself, and
 * Spanish comes from messages-es.ts (a missing key shows the English). `{name}` placeholders are
 * filled from `vars`, in both languages, so word order can differ between them:
 *
 *   t("Delete {name}?", { name })
 */
export type Vars = Record<string, string | number | null | undefined>;

export function translate<K extends string | null | undefined>(locale: "en" | "es", key: K, vars?: Vars): K {
  if (typeof key !== "string") return key;
  let text: string = locale === "es" ? (ES[key] ?? key) : key;
  if (vars) text = text.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => (name in vars ? String(vars[name] ?? "") : whole));
  return text as K;
}

export function useT() {
  const locale = useLocale();
  return useCallback(<K extends string | null | undefined>(key: K, vars?: Vars): K => translate(locale, key, vars), [locale]);
}

/** The same translator for code outside components (helpers, tables): uses the page's language at call time. */
export const tNow = <K extends string | null | undefined>(key: K, vars?: Vars): K => translate(currentLocale(), key, vars);
