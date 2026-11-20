import { LocaleLink as Link } from "@/components/LocaleProvider";
import { GlyphField } from "@/components/GlyphField";
import { IconArrowRight, IconCheck } from "@/components/icons";
import { polarEnabled } from "@/lib/polar";
import { getLocale } from "@/lib/locale";
import { breadcrumbLd, faqLd, JsonLd, pageMetadata, webPageLd } from "@/lib/seo";
import { takenSlots } from "@/lib/waitlist-db";
import { PRICE_RANGE } from "../pricing/plans";
import { PubTitle } from "../PubTitle";
import { pageUpdated } from "../site";
import { Included } from "./Included";
import { FOUNDING_PACKAGES_OPEN, SPONSOR_TIERS, SPONSORS_ON_POLAR, sponsorTiersFor } from "./sponsors";
import { TeamDemo } from "./TeamDemo";
import { Waitlist } from "./Waitlist";
import "./waitlist.css";

const DESCRIPTION = {
  en: `Join the Ragis waitlist for early access to AI answers from your company documents, cited to the page. Free to join${FOUNDING_PACKAGES_OPEN ? "; founding packages get in first" : ""}.`,
  es: `Únete a la lista de espera de Ragis para tener acceso anticipado a respuestas de IA sobre los documentos de tu empresa, citadas con la página. Unirse es gratis${FOUNDING_PACKAGES_OPEN ? "; los paquetes fundadores entran primero" : ""}.`,
};
const TITLE = { en: "Join the waitlist for early access", es: "Únete a la lista de espera para el acceso anticipado" };

export async function generateMetadata() {
  const locale = await getLocale();
  return pageMetadata({ title: TITLE[locale], description: DESCRIPTION[locale], path: "/waitlist", locale });
}

// What comes with Ragis besides answers, one slide each in the "Also included" slider, with the
// drawing of the matching app screen (public/illustrations/<art>.svg and <art>-dark.svg).
const INCLUDED = {
  en: [
    { art: "access-denied", title: "Access control", text: "People only get answers from files they can open." },
    { art: "documents-empty", title: "Tables and scans", text: "Read and cited like any other document." },
    { art: "agents-empty", title: "Agents", text: "Assistants for a team or a task." },
    { art: "workflows-empty", title: "Workflows", text: "Recurring steps, approved by a person." },
    { art: "signatures-empty", title: "Signatures", text: "Send, sign and verify documents." },
    { art: "activity-empty", title: "Audit trail", text: "Who asked what, and from which sources." },
  ],
  es: [
    { art: "access-denied", title: "Control de acceso", text: "Las personas solo reciben respuestas de los archivos que pueden abrir." },
    { art: "documents-empty", title: "Tablas y escaneos", text: "Se leen y se citan como cualquier otro documento." },
    { art: "agents-empty", title: "Agentes", text: "Asistentes para un equipo o una tarea." },
    { art: "workflows-empty", title: "Flujos de trabajo", text: "Pasos recurrentes, aprobados por una persona." },
    { art: "signatures-empty", title: "Firmas", text: "Envía, firma y verifica documentos." },
    { art: "activity-empty", title: "Registro de auditoría", text: "Quién preguntó qué, y con qué fuentes." },
  ],
};

// `text` is the plain answer, also published as FAQPage structured data; `a` overrides how it shows on the page.
type Faq = { q: string; text: string; a?: React.ReactNode };
const FAQ: Record<"en" | "es", Faq[]> = {
  en: [
    {
      q: "When do I get in?",
      text: FOUNDING_PACKAGES_OPEN
        ? "We open places in small groups. People with a founding package are invited first, then everyone else in the order they joined."
        : "We open places in small groups, in the order people joined.",
    },
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
  ],
  es: [
    {
      q: "¿Cuándo entro?",
      text: FOUNDING_PACKAGES_OPEN
        ? "Abrimos plazas en grupos pequeños. Las personas con un paquete fundador reciben la invitación primero, y después el resto, en el orden en que se unieron."
        : "Abrimos plazas en grupos pequeños, en el orden en que las personas se unieron.",
    },
    {
      q: "¿Cuánto costará?",
      text: `Unirse a la lista de espera es gratis. Los planes en la nube empiezan en $${PRICE_RANGE.low} al mes; consulta la página de precios para ver los detalles.`,
      a: (
        <>
          Unirse a la lista de espera es gratis. Los planes en la nube empiezan en ${PRICE_RANGE.low} al mes; consulta los <Link href="/pricing">precios</Link> para ver los detalles.
        </>
      ),
    },
    { q: "¿Dónde viven mis documentos?", text: "En tu propio espacio de trabajo, cifrados en tránsito y en reposo. Los equipos más grandes pueden tener una configuración dedicada o ejecutar Ragis en sus propios servidores." },
    { q: "¿Qué pasa con mi correo?", text: "Lo usamos para avisarte cuando se abra tu lugar. Para salir de la lista, responde a ese correo y te quitamos." },
  ],
};

export default async function WaitlistPage() {
  const locale = await getLocale();
  const es = locale === "es";
  // Slots taken come from confirmed sponsors in the database. If it can't be reached the page still renders, with every slot open.
  // With founding packages paused (FOUNDING_PACKAGES_OPEN) there are no tiers to show or count.
  const taken = FOUNDING_PACKAGES_OPEN
    ? await takenSlots().catch((err) => {
        console.error("[waitlist] could not read sponsor slots:", err instanceof Error ? err.message : err);
        return {} as Record<string, number>;
      })
    : {};
  const tiers = FOUNDING_PACKAGES_OPEN ? sponsorTiersFor(locale).map((tier) => ({ ...tier, taken: Math.min(taken[tier.id] ?? 0, tier.slots) })) : [];
  const faq = FAQ[locale];

  return (
    <div className="gate-col pub-col pub-col-wide wl">
      <JsonLd graph={[webPageLd({ path: "/waitlist", name: es ? "Lista de espera de Ragis" : "Ragis waitlist", description: DESCRIPTION[locale], updated: pageUpdated("/waitlist"), locale }), faqLd(faq), breadcrumbLd([{ name: es ? "Lista de espera" : "Waitlist", path: "/waitlist" }], locale)]} />
      <i className="gate-beam" data-line="left" aria-hidden="true" />
      <i className="gate-beam" data-line="right" aria-hidden="true" />

      <PubTitle
        title={
          <>
            {es ? "Acceso anticipado a respuestas" : "Early access to answers"}
            <br />
            {es ? "que tu empresa puede " : "your company can "}
            <em>{es ? "citar" : "cite"}</em>.
          </>
        }
        lead={es ? "Ragis lee los documentos de tu empresa y responde con la página exacta de la que sale cada afirmación. Únete a la lista de espera y te invitaremos a medida que se abran plazas." : "Ragis reads your company's documents and answers with the exact page each claim came from. Join the waitlist and we'll invite you as places open."}
        art="waitlist"
      />

      <Waitlist tiers={tiers} payments={polarEnabled() && SPONSORS_ON_POLAR}>
        <section className="wl-sec">
          {/* renders its own heading: the team named in it changes with the demo */}
          <TeamDemo />
        </section>

        <section className="wl-sec inc-sec">
          <Included items={INCLUDED[locale]} />
        </section>
      </Waitlist>

      <section className="wl-sec">
        <h2>
          {es ? "Conviene " : "Good to "}
          <em>{es ? "saber" : "know"}</em>.
        </h2>
        <ul className="wl-faq">
          {faq.map(({ q, text, a }) => (
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
          {es ? "Guarda tu lugar antes de que salgan las primeras " : "Save your place before the first "}
          <em>{es ? "invitaciones" : "invites"}</em>
          {es ? "." : " go out."}
        </h2>
        <div className="land-actions">
          <a href="#join" className="gate-cta land-cta">
            {es ? "Unirse a la lista de espera" : "Join the waitlist"}
            <IconArrowRight size={16} />
          </a>
          <ul className="gate-checks">
            {(es ? ["Unirse es gratis", "Un correo, sin boletines", "Sal cuando quieras"] : ["Free to join", "One email, no newsletters", "Leave any time"]).map((item) => (
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
