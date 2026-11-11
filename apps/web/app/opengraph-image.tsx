import { OG_SIZE, OG_TYPE, ogImage } from "@/lib/og";

export const dynamic = "force-static";
export const alt = "Ragis: answers your company can cite. A drawing of the Ragis mascot reading documents on a laptop.";
export const size = OG_SIZE;
export const contentType = OG_TYPE;

export default function Image() {
  return ogImage({
    eyebrow: "Cited answers",
    title: [["Answers your company"], ["can ", { em: "cite" }, "."]],
    lead: "Ragis reads your documents and answers with the exact page it came from.",
    checks: ["Cited answers", "Permission-aware", "PII redacted"],
    art: "landing",
  });
}
