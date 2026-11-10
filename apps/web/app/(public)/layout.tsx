import Link from "next/link";
import { cookies } from "next/headers";
import { Brand } from "@/components/Brand";
import { ThemeToggle } from "@/components/ThemeToggle";
import { demoCta, site } from "./site";
import "../landing.css";
import "./public.css";

/**
 * Shell for the public pages (pricing, terms, privacy). Same canvas and dashed
 * guides as the sign-in gate and landing, but the page scrolls.
 */
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const signedIn = (await cookies()).has("ragsis_session");

  return (
    <main className="gate pub">
      <header className="gate-top pub-top">
        <Link href="/" className="pub-home" aria-label="Ragis home">
          <Brand />
        </Link>
        <nav className="land-nav">
          <Link href="/pricing" className="pub-link">
            Pricing
          </Link>
          {!signedIn && demoCta && (
            <a href={demoCta.href} className="pub-link">
              {demoCta.label}
            </a>
          )}
          <ThemeToggle />
          <Link href={signedIn ? "/app" : "/login"} className="land-pill">
            {signedIn ? "Open workspace" : "Sign in"}
          </Link>
        </nav>
      </header>

      {children}

      <footer className="pub-foot">
        <span>
          © {new Date().getFullYear()} {site.legalEntity}
        </span>
        <nav>
          <Link href="/pricing">Pricing</Link>
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
        </nav>
      </footer>
    </main>
  );
}
