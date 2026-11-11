import { Special_Elite } from "next/font/google";

// Typewriter face for what is typed onto the demo papers (landing hero + waitlist team demo).
// Self-hosted by next/font at build time; exposed as --font-typewriter on the paper element.
export const typewriter = Special_Elite({ weight: "400", subsets: ["latin"], display: "swap", variable: "--font-typewriter" });
