"use client";

import Link from "next/link";
import { createContext, useContext, type ComponentProps } from "react";
import { localePath, type Locale } from "@/lib/i18n";

const LocaleContext = createContext<Locale>("en");

/** Gives client components the language of the page. The root layout wraps everything in it. */
export function LocaleProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export const useLocale = () => useContext(LocaleContext);

/** The URL of a public path in the page's language, for places that build a plain <a href>. */
export function useLocalePath() {
  const locale = useLocale();
  return (path: string) => localePath(locale, path);
}

/** next/link that stays in the page's language: href="/pricing" goes to /es/pricing on the Spanish site. */
export function LocaleLink({ href, ...props }: ComponentProps<typeof Link>) {
  const locale = useLocale();
  return <Link href={typeof href === "string" ? localePath(locale, href) : href} {...props} />;
}
