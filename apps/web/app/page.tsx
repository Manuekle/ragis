import { LocaleLink as Link } from "@/components/LocaleProvider";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { cookies } from "next/headers";
import { Brand } from "@/components/Brand";
import { DitherField } from "@/components/DitherField";
import { GlyphField } from "@/components/GlyphField";
import { Illustration } from "@/components/Illustration";
import { LandingDemo } from "@/components/LandingDemo";
import { SeasonalSnow } from "@/components/SeasonalSnow";
import { SiteFooter } from "@/components/SiteFooter";
import { SponsorWall } from "@/components/SponsorWall";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IconActivity, IconAgent, IconArrowRight, IconCheck, IconChat, IconFiles, IconShield, IconSignature, IconWorkflow } from "@/components/icons";
import type { Locale } from "@/lib/i18n";
import { getLocale } from "@/lib/locale";
import { currentSeason } from "@/lib/season";
import { faqLd, JsonLd, organizationLd, pageMetadata, softwareLd, webPageLd, websiteLd } from "@/lib/seo";
import { sponsorWall } from "@/lib/waitlist-db";
import { contentFor } from "./(public)/content";
import { demoCta, demoLabel, pageUpdated, publicOnly, signInHref, signInLabelFor, site, SITE_TEXT } from "./(public)/site";
import { FOUNDING_PACKAGES_OPEN, SPONSOR_TIERS } from "./(public)/waitlist/sponsors";
import "./(public)/public.css";
import "./landing.css";
import { LANDING } from "./landing-copy";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const locale = await getLocale();
  const text = SITE_TEXT[locale];
  return pageMetadata({ title: `${site.name}: ${text.tagline}`, description: text.description, path: "/", absoluteTitle: true, locale });
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
const lowestTier = usd.format(Math.min(...SPONSOR_TIERS.map((tier) => tier.price)));

/**
 * Landing, one page that scrolls. The hero keeps the sign-in gate's visual language (dashed guides,
 * crosses, travelling beams, dither horizon) and fits one viewport. Under it: the universities whose
 * people already use Ragis, then plain sections on what Ragis is, what it does and why to trust it,
 * the last call to action, the wall of sponsors (dressed like the hero) and the footer.
 */
export default async function Landing({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const season = currentSeason((await searchParams).season);
  const locale = await getLocale();
  const t = LANDING[locale];
  const text = SITE_TEXT[locale];
  const { STEPS, FEATURES, TRUST, LANDING_FAQ } = landingContent(locale);
  const signedIn = !publicOnly && (await cookies()).has("ragsis_session");
  // Confirmed sponsors from the waitlist. If the database can't be reached the wall still renders, every seat open.
  const sponsors = FOUNDING_PACKAGES_OPEN
    ? await sponsorWall().catch((err) => {
        console.error("[landing] could not read sponsors:", err instanceof Error ? err.message : err);
        return [];
      })
    : [];

  return (
    <main className="land-page">
      <JsonLd graph={[organizationLd(locale), websiteLd(locale), webPageLd({ path: "/", name: `${site.name}: ${text.tagline}`, description: text.description, updated: pageUpdated("/"), locale }), softwareLd({ locale }), faqLd(LANDING_FAQ)]} />
      <section className="gate land">
        <DitherField className="gate-dither" pattern="horizon" intensity={0.7} speed={0.6} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />
        {season.snow && <SeasonalSnow />}

        <Header signedIn={signedIn} locale={locale} />

        <div className="gate-col land-col">
          <i className="gate-beam" data-line="left" aria-hidden="true" />
          <i className="gate-beam" data-line="right" aria-hidden="true" />

          <div className="gate-title land-title">
            <i className="gate-beam" data-line="top" aria-hidden="true" />
            <i className="gate-beam" data-line="bottom" aria-hidden="true" />
            <i className="gate-x" data-at="tl" aria-hidden="true" />
            <i className="gate-x" data-at="tr" aria-hidden="true" />
            <i className="gate-x" data-at="bl" aria-hidden="true" />
            <i className="gate-x" data-at="br" aria-hidden="true" />
            <h1>
              {t.titleA}
              <br />
              {t.titleB}
              <em>{t.cite}</em>.
            </h1>
          </div>

          <div className="gate-body land-body">
            <p className="land-lead">{t.lead}</p>

            <div className="land-actions">
              <div className="land-buttons">
                <Link href={signedIn ? "/app" : "/waitlist"} className="gate-cta land-cta">
                  {signedIn ? t.openWorkspace : t.join}
                  <IconArrowRight size={16} />
                </Link>
                {!signedIn && demoCta && (
                  <a href={demoCta.href} className="gate-cta land-cta quiet premium">
                    {demoLabel(locale)}
                  </a>
                )}
              </div>
              <ul className="gate-checks land-checks">
                {t.checks.map((item) => (
                  <li key={item}>
                    <IconCheck size={12} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <LandingDemo />
          </div>
        </div>

        <div className="gate-foot" />
      </section>

      <div className="land-more-wrap">
        <div className="land-more">
          <section className="land-sec land-proof" aria-labelledby="land-proof-title">
            <ul className="land-proof-logos" aria-label={t.universities}>
              {UNIVERSITIES.map(({ name, src, width, height }) => (
                <li key={name}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- small static logo, already sized */}
                  <img src={src} alt={name} width={width} height={height} loading="lazy" decoding="async" />
                </li>
              ))}
            </ul>
            <div className="land-proof-copy">
              <h2 id="land-proof-title">
                {t.proofTitleA}
                <em>{t.proofTitleB}</em>.
              </h2>
              <p>{t.proofText}</p>
              {!signedIn && (
                <Link href="/waitlist" className="land-pill land-proof-cta">
                  {t.joinThem}
                  <IconArrowRight size={14} />
                </Link>
              )}
            </div>
          </section>

          <section id="how" className="land-sec">
            <div className="land-intro">
              <h2>
                {t.howA}
                <em>{t.howB}</em>.
              </h2>
              <Illustration name="landing" className="land-ill" />
            </div>
            <ol className="land-steps">
              {STEPS.map(({ n, Icon, title, text }) => (
                <li key={n} className="land-card">
                  <span className="land-card-n">{n}</span>
                  <span className="land-card-ico">
                    <Icon size={18} variant="duotone" />
                  </span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ol>
          </section>

          <section className="land-sec">
            <h2>
              {t.actA}
              <em>{t.actB}</em>
              {locale === "es" ? " sobre ellos." : " on them."}
            </h2>
            <ul className="land-feats">
              {FEATURES.map(({ Icon, title, text }) => (
                <li key={title} className="land-card">
                  <span className="land-card-ico">
                    <Icon size={18} variant="duotone" />
                  </span>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="land-sec">
            <h2>
              {t.allowedA}
              <em>{t.allowedB}</em>
              {locale === "es" ? " ver." : " to see."}
            </h2>
            <ul className="land-trust">
              {TRUST.map(({ title, text }) => (
                <li key={title}>
                  <IconCheck size={14} />
                  <div>
                    <strong>{title}</strong>
                    <span>{text}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>

          <section className="land-sec">
            <h2>
              {t.faqA}
              <em>{t.faqB}</em>.
            </h2>
            <ul className="land-faq">
              {LANDING_FAQ.map(({ q, text }) => (
                <li key={q}>
                  <h3>{q}</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ul>
          </section>

          <section className="land-sec land-final glyph-host">
            <GlyphField />
            <h2>
              {t.tryA}
              <em>{t.tryB}</em>.
            </h2>
            <div className="land-buttons">
              <Link href={signedIn ? "/app" : "/waitlist"} className="gate-cta land-cta">
                {signedIn ? t.openWorkspace : t.join}
                <IconArrowRight size={16} />
              </Link>
              {!signedIn && demoCta && (
                <a href={demoCta.href} className="gate-cta land-cta quiet premium">
                  {demoLabel(locale)}
                </a>
              )}
            </div>
          </section>
        </div>
      </div>

      {/* The wall of founding packages: only while they are offered (FOUNDING_PACKAGES_OPEN). */}
      {FOUNDING_PACKAGES_OPEN && (
      <section id="backers" className="gate land-wall">
        <DitherField className="gate-dither" pattern="horizon" intensity={0.7} speed={0.6} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />
        {season.snow && <SeasonalSnow />}

        <div className="gate-col land-col land-wall-col">
          <i className="gate-beam" data-line="left" aria-hidden="true" />
          <i className="gate-beam" data-line="right" aria-hidden="true" />

          <div className="gate-title land-title">
            <i className="gate-beam" data-line="top" aria-hidden="true" />
            <i className="gate-beam" data-line="bottom" aria-hidden="true" />
            <i className="gate-x" data-at="tl" aria-hidden="true" />
            <i className="gate-x" data-at="tr" aria-hidden="true" />
            <i className="gate-x" data-at="bl" aria-hidden="true" />
            <i className="gate-x" data-at="br" aria-hidden="true" />
            <h2>
              {t.wallA}
              <br />
              {t.wallB}
              <em>{t.wallC}</em>.
            </h2>
          </div>

          <div className="gate-body land-body">
            <p className="land-lead">{t.wallLead}</p>

            <div className="land-actions">
              <div className="land-buttons">
                <Link href="/waitlist#sponsor" className="gate-cta land-cta">
                  {t.takeSeat}
                  <IconArrowRight size={16} />
                </Link>
              </div>
              <ul className="gate-checks land-checks">
                {[t.oneTime(lowestTier), t.earlyAccess, t.nameStays].map((item) => (
                  <li key={item}>
                    <IconCheck size={12} />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <SponsorWall tiers={SPONSOR_TIERS} sponsors={sponsors} />
          </div>
        </div>

        <div className="gate-foot" />
      </section>
      )}

      <SiteFooter signedIn={signedIn} onLanding />
    </main>
  );
}

function Header({ signedIn, locale }: { signedIn: boolean; locale: Locale }) {
  const t = LANDING[locale];
  return (
    <header className="gate-top">
      <Brand />
      <nav className="land-nav">
        <Link href="/pricing" className="land-link">
          {t.pricing}
        </Link>
        <LanguageSwitch />
        <ThemeToggle />
        {signedIn ? (
          <Link href="/app" className="land-pill">
            {t.openWorkspace}
          </Link>
        ) : (
          <Link href={signInHref} className="land-pill">
            {signInLabelFor(locale)}
          </Link>
        )}
      </nav>
    </header>
  );
}

// People from these universities already use Ragis. Logos live in public/logos, sized at their intrinsic ratio.
const UNIVERSITIES = [
  { name: "Stanford University", src: "/logos/stanford.webp", width: 305, height: 102 },
  { name: "Duke University", src: "/logos/duke.svg", width: 201, height: 88 },
  { name: "MIT", src: "/logos/mit.svg", width: 321, height: 166 },
];

// The words live in (public)/content.ts, shared with /llms.txt; the icons go with them in order.
function landingContent(locale: Locale) {
  const { STEPS, FEATURES, TRUST, LANDING_FAQ } = contentFor(locale);
  return {
    STEPS: STEPS.map((step, i) => ({ ...step, Icon: [IconFiles, IconChat, IconShield][i]! })),
    FEATURES: FEATURES.map((feature, i) => ({ ...feature, Icon: [IconAgent, IconWorkflow, IconSignature, IconActivity][i]! })),
    TRUST,
    LANDING_FAQ,
  };
}
