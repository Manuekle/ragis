// Founding packages (early access) for the waitlist page. Edit prices, slot counts and perks here.
// The same text becomes the product description in Polar (lib/polar-catalog.ts), so what the buyer
// reads at checkout is what the page promised.
// How many slots are taken is not set here: it is the number of confirmed sponsors in the
// waitlist database (lib/waitlist-db.ts), so the page never shows a made-up count.

export type SponsorTier = {
  id: string;
  name: string;
  /** One-time amount in USD. */
  price: number;
  blurb: string;
  slots: number;
  perks: string[];
  featured?: boolean;
  /** Gold button, for the top tier. */
  premium?: boolean;
};

export const SPONSOR_TIERS: SponsorTier[] = [
  {
    id: "supporter",
    name: "Supporter",
    price: 49,
    blurb: "Early access before the public waitlist.",
    slots: 50,
    perks: ["Early access to the Ragis cloud workspace, before the public waitlist", "Your name on the supporters list", "Build notes from the team as we ship"],
  },
  {
    id: "backer",
    name: "Backer",
    price: 249,
    blurb: "Early access, set up on your own documents.",
    slots: 20,
    featured: true,
    perks: ["Everything in Supporter", "A guided onboarding session on your own documents", "A vote on what we build next", "Priority support during early access"],
  },
  {
    id: "founding",
    name: "Founding partner",
    price: 1500,
    blurb: "Early access, with a say in how Ragis grows.",
    slots: 5,
    premium: true,
    perks: ["Everything in Backer", "Your logo and link on the Ragis waitlist page", "A direct line to the people building Ragis", "A roadmap call every quarter"],
  },
];

/** The tiers' blurbs and perks in Spanish, by tier id. Names, prices and slots are the same in both languages. */
const SPONSOR_TEXT_ES: Record<string, Pick<SponsorTier, "blurb" | "perks">> = {
  supporter: {
    blurb: "Acceso anticipado antes de la lista de espera pública.",
    perks: ["Acceso anticipado al espacio de trabajo en la nube de Ragis, antes de la lista de espera pública", "Tu nombre en la lista de colaboradores", "Notas de construcción del equipo a medida que publicamos"],
  },
  backer: {
    blurb: "Acceso anticipado, configurado con tus propios documentos.",
    perks: ["Todo lo de Supporter", "Una sesión guiada de incorporación con tus propios documentos", "Voto sobre lo que construimos a continuación", "Soporte prioritario durante el acceso anticipado"],
  },
  founding: {
    blurb: "Acceso anticipado, con voz en cómo crece Ragis.",
    perks: ["Todo lo de Backer", "Tu logotipo y un enlace en la página de la lista de espera de Ragis", "Una línea directa con las personas que construyen Ragis", "Una llamada de hoja de ruta cada trimestre"],
  },
};

/** The sponsor tiers with their text in a language. */
export const sponsorTiersFor = (locale: "en" | "es"): SponsorTier[] => (locale === "es" ? SPONSOR_TIERS.map((tier) => ({ ...tier, ...SPONSOR_TEXT_ES[tier.id] })) : SPONSOR_TIERS);

/**
 * Whether founding packages are offered at all. Paused while Polar reviews the account: the
 * waitlist shows only the free early-access sign-up, the landing hides its wall, the terms drop
 * the "Founding packages" section, and the sign-up API refuses a tier. Turn it back on (and
 * decide how they are paid, see SPONSORS_ON_POLAR) to bring them back; nothing else changes.
 */
export const FOUNDING_PACKAGES_OPEN = false;

/**
 * Whether founding packages are sold through Polar. Off since Polar's review denied payment access
 * to the sponsor and early-access products (November 2026): the three Polar products are archived,
 * scripts/polar-sync.mjs does not recreate them, and the waitlist keeps its manual flow (we email
 * how to pay). Turn it on only after Polar agrees to sell them, then run the sync script.
 */
export const SPONSORS_ON_POLAR = false;

/**
 * The refund promise for a founding package. The waitlist page, the terms and the Polar product
 * descriptions (lib/polar-catalog.ts) all say exactly this, so change it here and run
 * scripts/polar-sync.mjs. A full refund in Polar frees the slot again (api/polar/webhook).
 */
export const REFUND_POLICY = "If we haven't given you access to Ragis yet, you can ask for a full refund of your package at any time by writing to support@ragis.app.";

/** The same promise in Spanish, for the Spanish pages. Keep it saying what REFUND_POLICY says. */
export const REFUND_POLICY_ES = "Si todavía no te hemos dado acceso a Ragis, puedes pedir en cualquier momento el reembolso completo de tu paquete escribiendo a support@ragis.app.";

/** Interest values the form and the API accept: plain early access, or one sponsor tier. */
export const EARLY_ACCESS = "access";
export const INTERESTS = [EARLY_ACCESS, ...SPONSOR_TIERS.map((tier) => tier.id)];
