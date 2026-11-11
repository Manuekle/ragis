import type { Metadata } from "next";
import { DitherField } from "@/components/DitherField";
import { Confirm } from "./Confirm";
import "../waitlist.css";

// The link carries a one-time token: keep the page out of search results and the token out of
// the Referer header of anything the page loads or links to.
export const metadata: Metadata = {
  title: "Confirm your place",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

/** Where the link in the confirmation email lands. */
export default async function ConfirmPage({ searchParams }: { searchParams: Promise<{ token?: string | string[] }> }) {
  const { token } = await searchParams;

  return (
    <div className="gate-col pub-col pub-col-wide wl">
      <i className="gate-beam" data-line="left" aria-hidden="true" />
      <i className="gate-beam" data-line="right" aria-hidden="true" />

      <section className="seats-stage wl-stage wl-confirm-stage">
        <DitherField className="seats-dither" pattern="waves" intensity={0.5} speed={0.4} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />
        <Confirm token={typeof token === "string" ? token : ""} />
      </section>
    </div>
  );
}
