import type { Metadata, Viewport } from "next";
import Script from "next/script";
import { SoftNav } from "@/components/SoftNav";
import { site, siteUrl } from "./(public)/site";
import "./globals.css";

// Defaults for every route. Public pages override them through pageMetadata (lib/seo.tsx); the
// share image comes from the opengraph-image.tsx files. No canonical here: it would point every
// page that doesn't set its own at the home page.
export const metadata: Metadata = {
  metadataBase: siteUrl(),
  title: { default: `${site.name}: ${site.tagline}`, template: `%s · ${site.name}` },
  description: site.description,
  applicationName: site.name,
  authors: [{ name: site.legalEntity }],
  creator: site.legalEntity,
  publisher: site.legalEntity,
  category: "business software",
  formatDetection: { telephone: false, address: false, email: false },
  openGraph: { type: "website", siteName: site.name, locale: "en_US" },
  twitter: { card: "summary_large_image" },
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, "max-image-preview": "large", "max-snippet": -1, "max-video-preview": -1 } },
};

// Browser chrome follows the canvas (--bg) in each theme.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#eeeef0" },
    { media: "(prefers-color-scheme: dark)", color: "#17171a" },
  ],
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
