import { headers } from "next/headers";
import { isLocale, LOCALE_HEADER, type Locale } from "./i18n";

/** The language the current request was made in. Server components, metadata and route handlers only. */
export async function getLocale(): Promise<Locale> {
  const value = (await headers()).get(LOCALE_HEADER);
  return isLocale(value) ? value : "en";
}
