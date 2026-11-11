import { OG_SIZE, OG_TYPE, ogImage } from "@/lib/og";

export const dynamic = "force-static";
export const alt = "Join the Ragis waitlist: early access to answers your company can cite.";
export const size = OG_SIZE;
export const contentType = OG_TYPE;

export default function Image() {
  return ogImage({
    eyebrow: "Waitlist",
    title: [["Early access to answers"], ["your company can ", { em: "cite" }, "."]],
    titleSize: 70,
    lead: "Join the waitlist. Sponsors get in first, then everyone in the order they joined.",
    checks: ["Free to join", "One email", "Leave any time"],
    art: "waitlist",
  });
}
