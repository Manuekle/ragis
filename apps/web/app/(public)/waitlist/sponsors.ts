// Sponsor tiers for the waitlist page. Edit prices, slot counts and perks here.
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
    blurb: "Chip in and skip the line.",
    slots: 50,
    perks: ["Invited before the public waitlist", "Your name on the supporters list", "Build notes from the team as we ship"],
  },
  {
    id: "backer",
    name: "Backer",
    price: 249,
    blurb: "For teams that want to shape the first release.",
    slots: 20,
    featured: true,
    perks: ["Everything in Supporter", "A guided setup session on your own documents", "A vote on what we build next", "Priority support during early access"],
  },
  {
    id: "founding",
    name: "Founding partner",
    price: 1500,
    blurb: "For companies that want Ragis built around their work.",
    slots: 5,
    premium: true,
    perks: ["Everything in Backer", "Your logo and link on this page", "A direct line to the people building Ragis", "A roadmap call every quarter"],
  },
];

/** Interest values the form and the API accept: plain early access, or one sponsor tier. */
export const EARLY_ACCESS = "access";
export const INTERESTS = [EARLY_ACCESS, ...SPONSOR_TIERS.map((tier) => tier.id)];
