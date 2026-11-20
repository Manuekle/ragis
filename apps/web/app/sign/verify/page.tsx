import type { Metadata } from "next";
import { getLocale } from "@/lib/locale";
import { VerifySignature } from "./verify";

export async function generateMetadata(): Promise<Metadata> {
  return { title: (await getLocale()) === "es" ? "Verificar un PDF firmado" : "Verify a signed PDF", robots: { index: false, follow: false } };
}

export default function VerifyPage() {
  return <VerifySignature />;
}
