import type { Locale } from "@/lib/i18n";

// The landing's own words (the sections' lists live in (public)/content.ts). Spanish is a plain
// translation of English, same order and same structure.

type Copy = {
  titleA: string;
  titleB: string;
  cite: string;
  lead: string;
  join: string;
  openWorkspace: string;
  checks: string[];
  universities: string;
  proofTitleA: string;
  proofTitleB: string;
  proofText: string;
  joinThem: string;
  howA: string;
  howB: string;
  actA: string;
  actB: string;
  allowedA: string;
  allowedB: string;
  faqA: string;
  faqB: string;
  tryA: string;
  tryB: string;
  wallA: string;
  wallB: string;
  wallC: string;
  wallLead: string;
  takeSeat: string;
  oneTime: (price: string) => string;
  earlyAccess: string;
  nameStays: string;
  pricing: string;
  /** Reading of the landing's heading for the page title and structured data. */
};

export const LANDING: Record<Locale, Copy> = {
  en: {
    titleA: "Answers your company",
    titleB: "can ",
    cite: "cite",
    lead: "Ragis reads your documents and answers with the exact page it came from. Permission-aware, PII-redacted, every claim traceable.",
    join: "Join the waitlist",
    openWorkspace: "Open workspace",
    checks: ["Cited answers", "Permission-aware", "PII redacted"],
    universities: "Universities",
    proofTitleA: "People at these universities already use ",
    proofTitleB: "Ragis",
    proofText: "Students and researchers from Stanford, Duke and MIT already ask Ragis about their own documents.",
    joinThem: "Join them",
    howA: "From a folder of files to an answer you can ",
    howB: "check",
    actA: "Once it knows your documents, it can ",
    actB: "act",
    allowedA: "Everyone sees what they're ",
    allowedB: "allowed",
    faqA: "Questions, ",
    faqB: "answered",
    tryA: "Try it on your own ",
    tryB: "documents",
    wallA: "Built with the teams",
    wallB: "who joined ",
    wallC: "early",
    wallLead: "The founding partners, backers and supporters who took a founding package before launch: early access to Ragis, and their place on this wall. The dotted seats are still open.",
    takeSeat: "Take a seat",
    oneTime: (price) => `One-time, from ${price}`,
    earlyAccess: "Early access",
    nameStays: "Your name stays here",
    pricing: "Pricing",
  },
  es: {
    titleA: "Respuestas que tu empresa",
    titleB: "puede ",
    cite: "citar",
    lead: "Ragis lee tus documentos y responde con la página exacta de la que sale cada dato. Respeta permisos, oculta datos personales y cada afirmación es rastreable.",
    join: "Unirse a la lista de espera",
    openWorkspace: "Abrir el espacio de trabajo",
    checks: ["Respuestas citadas", "Respeta permisos", "Datos personales ocultos"],
    universities: "Universidades",
    proofTitleA: "Personas de estas universidades ya usan ",
    proofTitleB: "Ragis",
    proofText: "Estudiantes e investigadores de Stanford, Duke y MIT ya le preguntan a Ragis sobre sus propios documentos.",
    joinThem: "Únete a ellos",
    howA: "De una carpeta de archivos a una respuesta que puedes ",
    howB: "comprobar",
    actA: "Cuando conoce tus documentos, puede ",
    actB: "actuar",
    allowedA: "Cada persona ve lo que tiene ",
    allowedB: "permitido",
    faqA: "Preguntas, ",
    faqB: "respondidas",
    tryA: "Pruébalo con tus propios ",
    tryB: "documentos",
    wallA: "Construido con los equipos",
    wallB: "que se unieron ",
    wallC: "pronto",
    wallLead: "Los socios fundadores, patrocinadores y colaboradores que tomaron un paquete fundador antes del lanzamiento: acceso anticipado a Ragis y su lugar en este muro. Los asientos punteados siguen libres.",
    takeSeat: "Reservar un asiento",
    oneTime: (price) => `Pago único, desde ${price}`,
    earlyAccess: "Acceso anticipado",
    nameStays: "Tu nombre se queda aquí",
    pricing: "Precios",
  },
};
