import { OG_SIZE, OG_TYPE, ogImage } from "@/lib/og";

export const dynamic = "force-static";
export const alt = "Ragis pricing: plans from $149 a month, every one with page citations.";
export const size = OG_SIZE;
export const contentType = OG_TYPE;

export default function Image() {
  return ogImage({
    eyebrow: "Pricing",
    title: [["Pricing that grows"], ["with your ", { em: "corpus" }, "."]],
    lead: "From $149 a month. Every plan cites the page and respects who can see what.",
    checks: ["Page citations", "Permissions", "SSO"],
    art: "pricing",
  });
}
