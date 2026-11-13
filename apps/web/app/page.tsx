import Link from "next/link";
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
import { currentSeason } from "@/lib/season";
import { faqLd, JsonLd, organizationLd, pageMetadata, softwareLd, webPageLd, websiteLd } from "@/lib/seo";
import { sponsorWall } from "@/lib/waitlist-db";
import { FEATURES as CONTENT_FEATURES, STEPS as CONTENT_STEPS, LANDING_FAQ, TRUST } from "./(public)/content";
import { demoCta, pageUpdated, publicOnly, signInHref, signInLabel, site } from "./(public)/site";
import { SPONSOR_TIERS } from "./(public)/waitlist/sponsors";
import "./(public)/public.css";
import "./landing.css";

export const dynamic = "force-dynamic";

export const metadata = pageMetadata({ title: `${site.name}: ${site.tagline}`, description: site.description, path: "/", absoluteTitle: true });

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
  const signedIn = !publicOnly && (await cookies()).has("ragsis_session");
  // Confirmed sponsors from the waitlist. If the database can't be reached the wall still renders, every seat open.
  const sponsors = await sponsorWall().catch((err) => {
    console.error("[landing] could not read sponsors:", err instanceof Error ? err.message : err);
    return [];
  });

  return (
    <main className="land-page">
      <JsonLd graph={[organizationLd(), websiteLd(), webPageLd({ path: "/", name: `${site.name}: ${site.tagline}`, description: site.description, updated: pageUpdated("/") }), softwareLd(), faqLd(LANDING_FAQ)]} />
      <section className="gate land">
        <DitherField className="gate-dither" pattern="horizon" intensity={0.7} speed={0.6} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />
        {season.snow && <SeasonalSnow />}

        <Header signedIn={signedIn} />

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
              Answers your company
              <br />
              can <em>cite</em>.
            </h1>
          </div>

          <div className="gate-body land-body">
            <p className="land-lead">Ragis reads your documents and answers with the exact page it came from. Permission-aware, PII-redacted, every claim traceable.</p>

            <div className="land-actions">
              <div className="land-buttons">
                <Link href={signedIn ? "/app" : "/waitlist"} className="gate-cta land-cta">
                  {signedIn ? "Open workspace" : "Join the waitlist"}
                  <IconArrowRight size={16} />
                </Link>
                {!signedIn && demoCta && (
                  <a href={demoCta.href} className="gate-cta land-cta quiet premium">
                    {demoCta.label}
                  </a>
                )}
              </div>
              <ul className="gate-checks land-checks">
                {["Cited answers", "Permission-aware", "PII redacted"].map((item) => (
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
            <ul className="land-proof-logos" aria-label="Universities">
              {UNIVERSITIES.map(({ name, src, width, height }) => (
                <li key={name}>
                  {/* eslint-disable-next-line @next/next/no-img-element -- small static logo, already sized */}
                  <img src={src} alt={name} width={width} height={height} loading="lazy" decoding="async" />
                </li>
              ))}
            </ul>
            <div className="land-proof-copy">
              <h2 id="land-proof-title">
                People at these universities already use <em>Ragis</em>.
              </h2>
              <p>Students and researchers from Stanford, Duke and MIT already ask Ragis about their own documents.</p>
              {!signedIn && (
                <Link href="/waitlist" className="land-pill land-proof-cta">
                  Join them
                  <IconArrowRight size={14} />
                </Link>
              )}
            </div>
          </section>

          <section id="how" className="land-sec">
            <div className="land-intro">
              <h2>
                From a folder of files to an answer you can <em>check</em>.
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
              Once it knows your documents, it can <em>act</em> on them.
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
              Everyone sees what they&apos;re <em>allowed</em> to see.
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
              Questions, <em>answered</em>.
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
              Try it on your own <em>documents</em>.
            </h2>
            <div className="land-buttons">
              <Link href={signedIn ? "/app" : "/waitlist"} className="gate-cta land-cta">
                {signedIn ? "Open workspace" : "Join the waitlist"}
                <IconArrowRight size={16} />
              </Link>
              {!signedIn && demoCta && (
                <a href={demoCta.href} className="gate-cta land-cta quiet premium">
                  {demoCta.label}
                </a>
              )}
            </div>
          </section>
        </div>
      </div>

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
              Built with the teams
              <br />
              who backed it <em>early</em>.
            </h2>
          </div>

          <div className="gate-body land-body">
            <p className="land-lead">The founding partners, backers and supporters who chipped in before launch. They get in first and keep their place here. The dotted seats are still open.</p>

            <div className="land-actions">
              <div className="land-buttons">
                <Link href="/waitlist#sponsor" className="gate-cta land-cta">
                  Take a seat
                  <IconArrowRight size={16} />
                </Link>
              </div>
              <ul className="gate-checks land-checks">
                {[`One-time, from ${lowestTier}`, "Invited first", "Your name stays here"].map((item) => (
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

      <SiteFooter signedIn={signedIn} onLanding />
    </main>
  );
}

function Header({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="gate-top">
      <Brand />
      <nav className="land-nav">
        <Link href="/pricing" className="land-link">
          Pricing
        </Link>
        <ThemeToggle />
        {signedIn ? (
          <Link href="/app" className="land-pill">
            Open workspace
          </Link>
        ) : (
          <Link href={signInHref} className="land-pill">
            {signInLabel}
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
const STEPS = CONTENT_STEPS.map((step, i) => ({ ...step, Icon: [IconFiles, IconChat, IconShield][i] }));
const FEATURES = CONTENT_FEATURES.map((feature, i) => ({ ...feature, Icon: [IconAgent, IconWorkflow, IconSignature, IconActivity][i] }));
