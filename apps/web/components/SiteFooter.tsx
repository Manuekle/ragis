import Link from "next/link"
import { demoCta, site } from "@/app/(public)/site"
import { Brand } from "./Brand"
import { FooterWordmark } from "./FooterWordmark"
import { IconArrowRight } from "./icons"
import { ThemeToggle } from "./ThemeToggle"

interface Props {
  signedIn: boolean
  /** On the landing the "how it works" view is already open, so skip that link. */
  onLanding?: boolean
}

/** Footer for the landing and every public page: pitch, link columns, wordmark, legal line. */
export function SiteFooter({ signedIn, onLanding = false }: Props) {
  const company = [
    demoCta && !signedIn ? { href: demoCta.href, label: demoCta.label } : null,
    site.contactEmail ? { href: `mailto:${site.contactEmail}`, label: "Contact" } : null,
  ].filter((x): x is { href: string; label: string } => x !== null)

  return (
    <footer className="sf">
      <div className="sf-inner">
        <div className="sf-top">
          <div className="sf-lead">
            <Link href="/" className="sf-brand" aria-label="Ragis home">
              <Brand />
            </Link>
            <p>Answers from your documents, with the exact page they came from.</p>
            <Link href={signedIn ? "/app" : "/waitlist"} className="gate-cta land-cta sf-cta">
              {signedIn ? "Open workspace" : "Join the waitlist"}
              <IconArrowRight size={16} />
            </Link>
          </div>

          <nav className="sf-cols" aria-label="Footer">
            <div>
              <h3>Product</h3>
              <ul>
                {!onLanding && (
                  <li>
                    <Link href="/#how">How it works</Link>
                  </li>
                )}
                <li>
                  <Link href="/pricing">Pricing</Link>
                </li>
                <li>
                  <Link href="/waitlist">Waitlist</Link>
                </li>
              </ul>
            </div>
            {company.length > 0 && (
              <div>
                <h3>Company</h3>
                <ul>
                  {company.map(({ href, label }) => (
                    <li key={label}>
                      <a href={href}>{label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <h3>Legal</h3>
              <ul>
                <li>
                  <Link href="/terms">Terms</Link>
                </li>
                <li>
                  <Link href="/privacy">Privacy</Link>
                </li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="sf-bottom">
          <span>
            © {new Date().getFullYear()} {site.legalEntity}
          </span>
          <ThemeToggle />
        </div>
      </div>

      <FooterWordmark />
    </footer>
  )
}
