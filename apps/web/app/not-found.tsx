import type { Metadata } from "next";
import { AppErrorState } from "@/components/AppState";
import { localePath } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLocale()) === "es" ? "Página no encontrada" : "Page not found", robots: { index: false } };
}

export default async function NotFound() {
  const locale = await getLocale();
  return (
    <main className="error-page">
      <AppErrorState kind="notFound" backHref={localePath(locale, "/")} backLabel={locale === "es" ? "Volver al inicio" : "Back to home"} locale={locale} />
    </main>
  );
}
