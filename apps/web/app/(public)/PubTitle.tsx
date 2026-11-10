import { Illustration, type IllustrationName } from "@/components/Illustration";

/** Headline block framed by guides and corner crosses, as on the gate. `art` adds a Ragis drawing on the right. */
export function PubTitle({ title, lead, art }: { title: React.ReactNode; lead?: React.ReactNode; art?: IllustrationName }) {
  return (
    <div className={art ? "gate-title pub-title has-art" : "gate-title pub-title"}>
      <i className="gate-beam" data-line="top" aria-hidden="true" />
      <i className="gate-beam" data-line="bottom" aria-hidden="true" />
      <i className="gate-x" data-at="tl" aria-hidden="true" />
      <i className="gate-x" data-at="tr" aria-hidden="true" />
      <i className="gate-x" data-at="bl" aria-hidden="true" />
      <i className="gate-x" data-at="br" aria-hidden="true" />
      <h1>{title}</h1>
      {lead && <p className="pub-lead">{lead}</p>}
      {art && (
        <div className="pub-title-art">
          <Illustration name={art} />
        </div>
      )}
    </div>
  );
}
