import type { Metadata } from "next";
import { getLocale } from "@/lib/locale";
import { GuestSignature } from "./signer";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLocale()) === "es" ? "Revisar y firmar" : "Review and sign", robots: { index: false, follow: false }, referrer: "no-referrer" };
}

export default function SignPage() {
  return <GuestSignature />;
}
