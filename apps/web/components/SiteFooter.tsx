import { demoCta, demoLabel, site } from "@/app/(public)/site"
import { getLocale } from "@/lib/locale"
import { Brand } from "./Brand"
import { FooterWordmark } from "./FooterWordmark"
import { IconArrowRight } from "./icons"
import { LanguageSwitch } from "./LanguageSwitch"
import { LocaleLink as Link } from "./LocaleProvider"
import { ThemeToggle } from "./ThemeToggle"

const TEXT = {
  en: { home: "Ragis home", pitch: "Answers from your documents, with the exact page they came from.", open: "Open workspace", join: "Join the waitlist", footer: "Footer", product: "Product", how: "How it works", pricing: "Pricing", waitlist: "Waitlist", company: "Company", contact: "Contact", legal: "Legal", terms: "Terms", privacy: "Privacy" },
  es: { home: "Inicio de Ragis", pitch: "Respuestas de tus documentos, con la página exacta de la que salen.", open: "Abrir el espacio de trabajo", join: "Unirse a la lista de espera", footer: "Pie de página", product: "Producto", how: "Cómo funciona", pricing: "Precios", waitlist: "Lista de espera", company: "Empresa", contact: "Contacto", legal: "Legal", terms: "Términos", privacy: "Privacidad" },
}

interface Props {
  signedIn: boolean
  /** On the landing the "how it works" view is already open, so skip that link. */
  onLanding?: boolean
}

/** Footer for the landing and every public page: pitch, link columns, wordmark, legal line. */
export async function SiteFooter({ signedIn, onLanding = false }: Props) {
  const locale = await getLocale()
  const t = TEXT[locale]
  const company = [
    demoCta && !signedIn ? { href: demoCta.href, label: demoLabel(locale) } : null,
    site.contactEmail ? { href: `mailto:${site.contactEmail}`, label: t.contact } : null,
  ].filter((x): x is { href: string; label: string } => x !== null)

  return (
    <footer className="sf">
      <div className="sf-inner">
        <div className="sf-top">
          <div className="sf-lead">
            <Link href="/" className="sf-brand" aria-label={t.home}>
              <Brand />
            </Link>
            <p>{t.pitch}</p>
            <Link href={signedIn ? "/app" : "/waitlist"} className="gate-cta land-cta sf-cta">
              {signedIn ? t.open : t.join}
              <IconArrowRight size={16} />
            </Link>
          </div>

          <nav className="sf-cols" aria-label={t.footer}>
            <div>
              <h3>{t.product}</h3>
              <ul>
                {!onLanding && (
                  <li>
                    <Link href="/#how">{t.how}</Link>
                  </li>
                )}
                <li>
                  <Link href="/pricing">{t.pricing}</Link>
                </li>
                <li>
                  <Link href="/waitlist">{t.waitlist}</Link>
                </li>
              </ul>
            </div>
            {company.length > 0 && (
              <div>
                <h3>{t.company}</h3>
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
              <h3>{t.legal}</h3>
              <ul>
                <li>
                  <Link href="/terms">{t.terms}</Link>
                </li>
                <li>
                  <Link href="/privacy">{t.privacy}</Link>
                </li>
              </ul>
            </div>
          </nav>
        </div>

        <div className="sf-bottom">
          <span>
            © {new Date().getFullYear()} {site.legalEntity}
          </span>
          <span className="sf-toggles">
            <LanguageSwitch />
            <ThemeToggle />
          </span>
        </div>
      </div>

      <FooterWordmark />
    </footer>
  )
}
