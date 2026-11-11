import { OG_SIZE, OG_TYPE, ogImage } from "@/lib/og";

export const dynamic = "force-static";
export const alt = "Ragis Terms of Service: the rules for using Ragis, written to be read.";
export const size = OG_SIZE;
export const contentType = OG_TYPE;

export default function Image() {
  return ogImage({
    eyebrow: "Terms",
    title: [["Terms of ", { em: "Service" }, "."]],
    titleSize: 96,
    lead: "The rules for using Ragis, written to be read. Your documents stay yours.",
    checks: ["You own your content", "Plain language"],
    art: "terms",
  });
}
