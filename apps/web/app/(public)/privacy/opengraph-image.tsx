import { OG_SIZE, OG_TYPE, ogImage } from "@/lib/og";

export const dynamic = "force-static";
export const alt = "Ragis Privacy Policy: what we collect, why, and how you stay in control.";
export const size = OG_SIZE;
export const contentType = OG_TYPE;

export default function Image() {
  return ogImage({
    eyebrow: "Privacy",
    title: [["Privacy ", { em: "Policy" }, "."]],
    titleSize: 96,
    lead: "What we collect, why, where it lives and how you stay in control.",
    checks: ["Never sold", "No model training", "PII redacted"],
    art: "privacy",
  });
}
