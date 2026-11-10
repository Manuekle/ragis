import type { IllustrationName } from "@/components/Illustration";
import { PubTitle } from "./PubTitle";
import { site } from "./site";

export interface LegalSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

/** Legal document: framed title, sticky table of contents, numbered sections. */
export function LegalPage({ title, lead, sections, art }: { title: React.ReactNode; lead: React.ReactNode; sections: LegalSection[]; art?: IllustrationName }) {
  return (
    <div className="gate-col pub-col">
      <i className="gate-beam" data-line="left" aria-hidden="true" />
      <i className="gate-beam" data-line="right" aria-hidden="true" />

      <PubTitle title={title} lead={lead} art={art} />

      <div className="pub-body legal">
        <aside className="legal-toc" aria-label="On this page">
          <span className="legal-updated">Updated {site.legalUpdated}</span>
          <ol>
            {sections.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`}>{s.title}</a>
              </li>
            ))}
          </ol>
        </aside>
        <article className="legal-doc">
          {sections.map((s, i) => (
            <section key={s.id} id={s.id}>
              <h2>
                <span className="legal-n">{String(i + 1).padStart(2, "0")}</span>
                {s.title}
              </h2>
              {s.body}
            </section>
          ))}
        </article>
      </div>
    </div>
  );
}

/** "email us at …" when CONTACT_EMAIL is set, otherwise point to the agreement. */
export function ContactLine() {
  return site.contactEmail ? (
    <>
      email us at <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a>
    </>
  ) : (
    <>use the contact listed in your agreement or order form</>
  );
}
