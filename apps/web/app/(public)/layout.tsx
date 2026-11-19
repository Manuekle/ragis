import { cookies } from "next/headers";
import { Brand } from "@/components/Brand";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { LocaleLink as Link } from "@/components/LocaleProvider";
import { SiteFooter } from "@/components/SiteFooter";
import { ThemeToggle } from "@/components/ThemeToggle";
import { getLocale } from "@/lib/locale";
import { demoCta, demoLabel, publicOnly, signInHref, signInLabelFor } from "./site";
import "../landing.css";
import "./public.css";

/**
 * Shell for the public pages (pricing, terms, privacy). Same canvas and dashed
 * guides as the sign-in gate and landing, but the page scrolls.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const signedIn = !publicOnly && (await cookies()).has("ragsis_session");
  const locale = await getLocale();
  const es = locale === "es";

  return (
    <main className="gate pub">
      <header className="gate-top pub-top">
        <Link href="/" className="pub-home" aria-label={es ? "Inicio de Ragis" : "Ragis home"}>
          <Brand />
        </Link>
        <nav className="land-nav">
          <Link href="/pricing" className="pub-link">
            {es ? "Precios" : "Pricing"}
          </Link>
          {!signedIn && demoCta && (
            <a href={demoCta.href} className="pub-link">
              {demoLabel(locale)}
            </a>
          )}
          <LanguageSwitch />
          <ThemeToggle />
          <Link href={signedIn ? "/app" : signInHref} className="land-pill">
            {signedIn ? (es ? "Abrir el espacio de trabajo" : "Open workspace") : signInLabelFor(locale)}
          </Link>
        </nav>
      </header>

      {children}

      <SiteFooter signedIn={signedIn} />
    </main>
  );
}
