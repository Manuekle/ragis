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

/**
 * The refund promise for a founding package. The waitlist page, the terms and the Polar product
 * descriptions (lib/polar-catalog.ts) all say exactly this, so change it here and run
 * scripts/polar-sync.mjs. A full refund in Polar frees the slot again (api/polar/webhook).
 */
export const REFUND_POLICY = "If we haven't given you access to Ragis yet, you can ask for a full refund of your package at any time by writing to support@ragis.app.";

/** Interest values the form and the API accept: plain early access, or one sponsor tier. */
export const EARLY_ACCESS = "access";
export const INTERESTS = [EARLY_ACCESS, ...SPONSOR_TIERS.map((tier) => tier.id)];
