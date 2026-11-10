/** Utilidades de renderizado a Markdown para los documentos sincronizados. */

export const md = (s: string) => s.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

export function slug(s: string, max = 80): string {
  const base = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\w\s-]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, max)
    .replace(/-+$/g, "");
  return base || "untitled";
}

export const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function isoMinute(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export const decodeEntities = (s: string) =>
  s.replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/** HTML de correo → texto legible (sin ejecutar nada: solo expresiones regulares sobre texto). */
export function htmlToText(html: string): string {
  return md(
    decodeEntities(
      html
        .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, "")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, "\n")
        .replace(/<li[^>]*>/gi, "- ")
        .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => {
          const t = text.replace(/<[^>]+>/g, "").trim();
          return t && t !== href ? `${t} (${href})` : href;
        })
        .replace(/<[^>]+>/g, ""),
    )
      .split("\n")
      .map((l) => l.replace(/[ \t]+/g, " ").trim())
      .join("\n"),
  );
}

/** Quita el texto citado de respuestas de correo (evita indexar el mismo mensaje N veces en un hilo). */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const nextJoined = `${l} ${lines[i + 1] ?? ""}`;
    if (/^-{2,}\s*(Original Message|Mensaje original)\s*-{2,}/i.test(l)) break;
    if (/^(On|El) .{4,200}(wrote|escribi[oó]):\s*$/i.test(l) || /^(On|El) .{4,200}(wrote|escribi[oó]):\s*$/i.test(nextJoined.trim())) break;
    if (/^>/.test(l)) continue;
    out.push(l);
  }
  return md(out.join("\n"));
}

export const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** Tipo admitido por el pipeline para un adjunto, o null si no se indexa. */
export function attachmentType(filename: string, mimeType: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const byExt = MIME_BY_EXT[ext];
  const mime = mimeType.toLowerCase().split(";")[0]!.trim();
  if (Object.values(MIME_BY_EXT).includes(mime) && (!byExt || byExt === mime)) return mime;
  return byExt ?? null;
}
