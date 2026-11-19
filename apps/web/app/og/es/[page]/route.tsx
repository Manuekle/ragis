import { notFound } from "next/navigation";
import { FOUNDING_PACKAGES_OPEN } from "@/app/(public)/waitlist/sponsors";
import { ogImage, type OgCard } from "@/lib/og";

// Spanish share cards: the same drawings as each page's opengraph-image.tsx, with the words in Spanish.
// pageMetadata (lib/seo.tsx) points the Spanish pages here.
export const dynamic = "force-static";

const CARDS: Record<string, OgCard> = {
  home: {
    eyebrow: "Respuestas citadas",
    title: [["Respuestas que tu empresa"], ["puede ", { em: "citar" }, "."]],
    lead: "Ragis lee tus documentos y responde con la página exacta de la que sale cada dato.",
    checks: ["Respuestas citadas", "Respeta permisos", "Sin datos personales"],
    art: "landing",
  },
  pricing: {
    eyebrow: "Precios",
    title: [["Precios que crecen"], ["con tu ", { em: "corpus" }, "."]],
    lead: "Desde $149 al mes. Todos los planes citan la página y respetan quién puede ver qué.",
    checks: ["Citas de página", "Permisos", "SSO"],
    art: "pricing",
  },
  waitlist: {
    eyebrow: "Lista de espera",
    title: [["Acceso anticipado a respuestas"], ["que tu empresa puede ", { em: "citar" }, "."]],
    titleSize: 62,
    lead: FOUNDING_PACKAGES_OPEN
      ? "Entra en la lista de espera. Los paquetes fundadores entran primero, y después el resto por orden de llegada."
      : "Entra en la lista de espera. Abrimos plazas en grupos pequeños, por orden de llegada.",
    checks: ["Gratis", "Un solo correo", "Sal cuando quieras"],
    art: "waitlist",
  },
  privacy: {
    eyebrow: "Privacidad",
    title: [["Política de ", { em: "privacidad" }, "."]],
    titleSize: 84,
    lead: "Qué datos recogemos, por qué, dónde viven y cómo mantienes el control.",
    checks: ["Nunca se venden", "Sin entrenar modelos", "Sin datos personales"],
    art: "privacy",
  },
  terms: {
    eyebrow: "Términos",
    title: [["Términos del ", { em: "servicio" }, "."]],
    titleSize: 84,
    lead: "Las reglas para usar Ragis, escritas para que se lean. Tus documentos siguen siendo tuyos.",
    checks: ["Tu contenido es tuyo", "Lenguaje claro"],
    art: "terms",
  },
};

export function generateStaticParams() {
  return Object.keys(CARDS).map((page) => ({ page }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ page: string }> }) {
  const card = CARDS[(await params).page];
  if (!card) notFound();
  return ogImage(card);
}
