import Link from "next/link";
import { Brand } from "@/components/Brand";
import { DitherField } from "@/components/DitherField";
import { IconCheck } from "@/components/icons";

/**
 * Centered single-column gate used by sign-in and the organization picker.
 * Dashed guides frame the column and the headline; crosses mark where they meet.
 * The guides draw in on load, then march slowly while a light beam runs along each one.
 * A Magic UI DitherField (horizon pattern) glows up from the bottom band that the empty foot row reserves.
 */
export function AuthShell({
  title,
  lead,
  aside,
  linkBrandToHome = false,
  children,
}: {
  title: React.ReactNode;
  lead?: React.ReactNode;
  aside?: React.ReactNode;
  linkBrandToHome?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main className="gate">
      <DitherField className="gate-dither" pattern="horizon" intensity={0.7} speed={0.6} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />
      <header className="gate-top">
        {linkBrandToHome ? (
          <Link href="/" aria-label="Ragis home" style={{ display: "inline-flex" }}>
            <Brand />
          </Link>
        ) : (
          <Brand />
        )}
        {aside}
      </header>
      <div className="gate-col">
        <i className="gate-beam" data-line="left" aria-hidden="true" />
        <i className="gate-beam" data-line="right" aria-hidden="true" />
        <div className="gate-title">
          <i className="gate-beam" data-line="top" aria-hidden="true" />
          <i className="gate-beam" data-line="bottom" aria-hidden="true" />
          <i className="gate-x" data-at="tl" aria-hidden="true" />
          <i className="gate-x" data-at="tr" aria-hidden="true" />
          <i className="gate-x" data-at="bl" aria-hidden="true" />
          <i className="gate-x" data-at="br" aria-hidden="true" />
          <h1>
            {title}
            {lead && <span className="gate-lead">{lead}</span>}
          </h1>
        </div>
        <div className="gate-body">{children}</div>
      </div>
      <div className="gate-foot" />
    </main>
  );
}

export function GateChecks({ items }: { items: string[] }) {
  return (
    <ul className="gate-checks">
      {items.map((item) => (
        <li key={item}>
          <IconCheck size={12} />
          {item}
        </li>
      ))}
    </ul>
  );
}
