import type { Metadata } from "next";
import { VerifySignature } from "./verify";

export const metadata: Metadata = { title: "Verify a signed PDF", robots: { index: false, follow: false } };

export default function VerifyPage() {
  return <VerifySignature />;
}
