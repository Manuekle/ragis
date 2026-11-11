import type { Metadata } from "next";
import { GuestSignature } from "./signer";

export const metadata: Metadata = { title: "Review and sign", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default function SignPage() {
  return <GuestSignature />;
}
