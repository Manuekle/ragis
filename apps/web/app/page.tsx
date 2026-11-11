import Link from "next/link";
import { cookies } from "next/headers";
import { Brand } from "@/components/Brand";
import { DitherField } from "@/components/DitherField";
import { GlyphField } from "@/components/GlyphField";
import { Illustration } from "@/components/Illustration";
import { LandingDemo } from "@/components/LandingDemo";
import { LandingViews } from "@/components/LandingViews";
import { SiteFooter } from "@/components/SiteFooter";
import { SponsorWall } from "@/components/SponsorWall";
import { ThemeToggle } from "@/components/ThemeToggle";
import { IconActivity, IconAgent, IconArrowRight, IconCheck, IconChat, IconFiles, IconShield, IconSignature, IconWorkflow } from "@/components/icons";
import { sponsorWall } from "@/lib/waitlist-db";
import { demoCta, publicOnly, signInHref, signInLabel } from "./(public)/site";
import { SPONSOR_TIERS } from "./(public)/waitlist/sponsors";
import "./(public)/public.css";
import "./landing.css";

export const dynamic = "force-dynamic";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0 });
const lowestTier = usd.format(Math.min(...SPONSOR_TIERS.map((tier) => tier.price)));

/**
 * Landing, in three views. The hero keeps the sign-in gate's visual language (dashed guides,
 * crosses, travelling beams, dither horizon) and fits one viewport. "See how it works" swaps it
 * for plain sections on what Ragis is, what it does and why to trust it, ending on the last call
 * to action; "Backers" then opens the wall of sponsors, dressed like the hero, with the
 * footer under it. A button at the top steps back, so the hero is never scrolled past, only left
 * and re-entered.
 */
export default async function Landing() {
  const signedIn = !publicOnly && (await cookies()).has("ragsis_session");
  // Confirmed sponsors from the waitlist. If the database can't be reached the wall still renders, every seat open.
  const sponsors = await sponsorWall().catch((err) => {
    console.error("[landing] could not read sponsors:", err instanceof Error ? err.message : err);
    return [];
  });

  return (
    <main className="land-page">
      <LandingViews
        hero={
          <section className="gate land">
            <DitherField className="gate-dither" pattern="horizon" intensity={0.7} speed={0.6} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />

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
        }
        more={
          <div className="land-more-wrap">
            <Header signedIn={signedIn} />

            <div id="how" className="land-more">
              <section className="land-sec">
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
        }
        wall={
          <>
            <section id="backers" className="gate land-wall">
              <DitherField className="gate-dither" pattern="horizon" intensity={0.7} speed={0.6} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />

              <Header signedIn={signedIn} />

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
          </>
        }
      />
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

const STEPS = [
  { n: "01", Icon: IconFiles, title: "Connect your documents", text: "Upload PDFs, Word files, slides, spreadsheets and scans. Ragis reads the text, tables, charts and figures." },
  { n: "02", Icon: IconChat, title: "Ask in plain language", text: "Anyone on the team asks a question. Answers come from your documents only, never from the open web." },
  { n: "03", Icon: IconShield, title: "Check the source", text: "Every claim links to the document and page it came from. Claims the sources don't support are caught before you see them." },
];

const FEATURES = [
  { Icon: IconAgent, title: "Agents", text: "Build assistants for a team or a task in Agent Studio. Set what they can use, test them in a sandbox, ship versioned releases." },
  { Icon: IconWorkflow, title: "Workflows", text: "Turn a recurring process into steps that run on their own and wait for a person whenever a decision is needed." },
  { Icon: IconSignature, title: "Signatures", text: "Send a document to be signed and keep a verifiable record of who signed what, and when." },
  { Icon: IconActivity, title: "Audit trail", text: "See who asked what, which sources were used and what each model call cost." },
];

const TRUST = [
  { title: "Permission-aware answers", text: "Access follows your org, workspace, group and document rules. A question never surfaces a file you couldn't open." },
  { title: "PII redacted", text: "Personal data is detected and masked when documents are ingested." },
  { title: "Choose where models run", text: "Pick the models and the region, or run them on-prem for restricted teams." },
  { title: "Single sign-on", text: "Plug into your identity provider. API keys scoped per workspace for integrations." },
];
