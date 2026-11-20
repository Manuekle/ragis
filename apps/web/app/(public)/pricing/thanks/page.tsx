import type { Metadata } from "next";
import { LocaleLink as Link } from "@/components/LocaleProvider";
import { DitherField } from "@/components/DitherField";
import { IconArrowRight, IconCheck } from "@/components/icons";
import { getLocale } from "@/lib/locale";
import { site } from "../../site";
import "../../waitlist/waitlist.css";

// A private landing after paying: nothing here for search engines.
export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLocale()) === "es" ? "Gracias" : "Thank you", robots: { index: false, follow: false } };
}

/** Where Polar sends the buyer after a cloud plan is paid (api/checkout). */
export default async function ThanksPage() {
  const es = (await getLocale()) === "es";
  return (
    <div className="gate-col pub-col pub-col-wide wl">
      <i className="gate-beam" data-line="left" aria-hidden="true" />
      <i className="gate-beam" data-line="right" aria-hidden="true" />

      <section className="seats-stage wl-stage wl-confirm-stage">
        <DitherField className="seats-dither" pattern="waves" intensity={0.5} speed={0.4} interactive={false} color={["var(--dither-low)", "var(--dither-mid)", "var(--dither-high)"]} />
        <div className="wl-card wl-done" role="status">
          <span className="wl-done-mark">
            <IconCheck size={20} strokeWidth={2.2} />
          </span>
          <h1>{es ? "Gracias. Ya estás dentro." : "Thank you. You're in."}</h1>
          <p>{es ? "Tu pago se ha completado y Polar te ha enviado el recibo por correo. Te escribiremos a la dirección con la que pagaste para configurar tu espacio de trabajo." : "Your payment went through, and Polar emailed you the receipt. We'll write to the address you paid with to set up your workspace."}</p>
          <p className="wl-fine">
            {es ? "¿Dudas sobre el pago?" : "Questions about the payment?"} {site.contactEmail ? <a href={`mailto:${site.contactEmail}`}>{site.contactEmail}</a> : es ? "Responde al correo del recibo." : "Reply to the receipt email."}
          </p>
          <Link href="/" className="wl-back">
            {es ? "Volver a Ragis" : "Back to Ragis"}
            <IconArrowRight size={14} />
          </Link>
        </div>
      </section>
    </div>
  );
}
