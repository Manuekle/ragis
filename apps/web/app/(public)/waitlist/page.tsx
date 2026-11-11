import Link from "next/link";
import { GlyphField } from "@/components/GlyphField";
import { IconArrowRight, IconCheck } from "@/components/icons";
import { breadcrumbLd, faqLd, JsonLd, pageMetadata, webPageLd } from "@/lib/seo";
import { takenSlots } from "@/lib/waitlist-db";
import { PRICE_RANGE } from "../pricing/plans";
import { PubTitle } from "../PubTitle";
import { pageUpdated } from "../site";
import { Included } from "./Included";
import { SPONSOR_TIERS } from "./sponsors";
import { TeamDemo } from "./TeamDemo";
import { Waitlist } from "./Waitlist";
import "./waitlist.css";

const DESCRIPTION = "Join the Ragis waitlist for early access to AI answers from your company documents, cited to the page. Free to join; sponsors are invited first.";

export const metadata = pageMetadata({ title: "Join the waitlist for early access", description: DESCRIPTION, path: "/waitlist" });

// What comes with Ragis besides answers, one slide each in the "Also included" slider, with the
// drawing of the matching app screen (public/illustrations/<art>.svg and <art>-dark.svg).
const INCLUDED = [
  { art: "access-denied", title: "Access control", text: "People only get answers from files they can open." },
  { art: "documents-empty", title: "Tables and scans", text: "Read and cited like any other text." },
  { art: "agents-empty", title: "Agents", text: "Assistants for a team or a task." },
  { art: "workflows-empty", title: "Workflows", text: "Recurring steps, with a person approving." },
  { art: "signatures-empty", title: "Signatures", text: "Send, sign and verify documents." },
  { art: "activity-empty", title: "Audit trail", text: "Who asked what, with which sources." },
];

// `text` is the plain answer, also published as FAQPage structured data; `a` overrides how it shows on the page.
const FAQ: { q: string; text: string; a?: React.ReactNode }[] = [
  { q: "When do I get in?", text: "We open places in small groups. Sponsors are invited first, then everyone else in the order they joined." },
  {
    q: "What will it cost?",
    text: `Joining the waitlist is free. Cloud plans start at $${PRICE_RANGE.low} a month; see the pricing page for the details.`,
    a: (
      <>
        Joining the waitlist is free. Cloud plans start at ${PRICE_RANGE.low} a month; see <Link href="/pricing">pricing</Link> for the details.
      </>
    ),
  },
  { q: "Where do my documents live?", text: "In your own workspace, encrypted in transit and at rest. Larger teams can have a dedicated setup or run Ragis on their own servers." },
  { q: "What happens with my email?", text: "We use it to tell you when your place opens. To leave the list, reply to that email and we remove you." },
];

export default async function WaitlistPage() {
  // Slots taken come from confirmed sponsors in the database. If it can't be reached the page still renders, with every slot open.
  const taken = await takenSlots().catch((err) => {
    console.error("[waitlist] could not read sponsor slots:", err instanceof Error ? err.message : err);
    return {} as Record<string, number>;
  });
  const tiers = SPONSOR_TIERS.map((tier) => ({ ...tier, taken: Math.min(taken[tier.id] ?? 0, tier.slots) }));

  return (
    <div className="gate-col pub-col pub-col-wide wl">
      <JsonLd graph={[webPageLd({ path: "/waitlist", name: "Ragis waitlist", description: DESCRIPTION, updated: pageUpdated("/waitlist") }), faqLd(FAQ), breadcrumbLd([{ name: "Waitlist", path: "/waitlist" }])]} />
      <i className="gate-beam" data-line="left" aria-hidden="true" />
      <i className="gate-beam" data-line="right" aria-hidden="true" />

      <PubTitle
        title={
          <>
            Early access to answers
            <br />
            your company can <em>cite</em>.
          </>
        }
        lead="Ragis reads your company's documents and answers with the exact page each claim came from. Join the waitlist and we'll invite you as places open."
        art="waitlist"
      />

      <Waitlist tiers={tiers}>
        <section className="wl-sec">
          {/* renders its own heading: the team named in it changes with the demo */}
          <TeamDemo />
        </section>

        <section className="wl-sec inc-sec">
          <Included items={INCLUDED} />
        </section>
      </Waitlist>

      <section className="wl-sec">
        <h2>
          Good to <em>know</em>.
        </h2>
        <ul className="wl-faq">
          {FAQ.map(({ q, text, a }) => (
            <li key={q}>
              <h3>{q}</h3>
              <p>{a ?? text}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="wl-sec wl-final glyph-host">
        <GlyphField />
        <h2>
          Save your place before the first <em>invites</em> go out.
        </h2>
        <div className="land-actions">
          <a href="#join" className="gate-cta land-cta">
            Join the waitlist
            <IconArrowRight size={16} />
          </a>
          <ul className="gate-checks">
            {["Free to join", "One email, no newsletters", "Leave any time"].map((item) => (
              <li key={item}>
                <IconCheck size={12} />
                {item}
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}
