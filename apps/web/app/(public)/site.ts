// Public-site settings for the homepage, pricing and legal pages.

export const site = {
  name: "Ragis",
  legalEntity: process.env.LEGAL_ENTITY ?? "Ragis",
  contactEmail: process.env.CONTACT_EMAIL ?? null,
  /** Date shown on Terms and Privacy. Bump it whenever either text changes. */
  legalUpdated: "November 9, 2026",
};

/** Where "Contact sales" goes: a mailto when CONTACT_EMAIL is set, otherwise sign-in. */
export const salesHref = site.contactEmail ? `mailto:${site.contactEmail}?subject=Ragis%20sales` : "/login";

const bookingUrl = URL.parse(process.env.DEMO_BOOKING_URL ?? "");
const demoEmail = site.contactEmail?.trim();

export const demoCta = bookingUrl?.protocol === "https:"
  ? { label: "Book a demo", href: bookingUrl.href }
  : demoEmail
    ? { label: "Request a demo", href: `mailto:${demoEmail}?subject=Ragis%20demo%20request` }
    : null;
