import type { Metadata } from "next";
import Script from "next/script";
import { SoftNav } from "@/components/SoftNav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Ragis",
  description: "Verifiable answers from your company's document knowledge",
};

const themeInit = `try {
  var theme = localStorage.getItem("ragsis:theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch (e) {}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      {/* Extensions (ColorZilla, Grammarly…) inject attributes on <body> before hydration. */}
      <body suppressHydrationWarning>
        <Script id="theme-init" strategy="beforeInteractive" dangerouslySetInnerHTML={{ __html: themeInit }} />
        <SoftNav />
        {children}
      </body>
    </html>
  );
}
