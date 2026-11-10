import { createPrivateKey, createPublicKey, hkdfSync, sign } from "node:crypto";
import { PDFDocument, PDFName, PDFSignature, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import type { Deps } from "../app.js";
import { ApiError, conflict } from "./errors.js";
import { sha256, type EnvDoc } from "./external-actions.js";
import { canonical } from "./policy.js";

export const MAX_SIGNATURE_BYTES = 20 * 1024 * 1024;
export const MAX_SIGNATURE_PAGES = 400;

export async function signaturePdf(bytes: Buffer) {
  try {
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true });
    if (pdf.getPageCount() === 0 || pdf.getPageCount() > MAX_SIGNATURE_PAGES) throw new Error("page count");
    if (pdf.catalog.getAcroForm()?.dict.has(PDFName.of("XFA"))) throw new Error("unsupported form");
    const form = pdf.getForm();
    const fields = form.getFields();
    if (fields.some((field) => field instanceof PDFSignature)) throw new Error("unsupported form");
    if (fields.length) form.flatten({ updateFieldAppearances: false });
    return pdf;
  } catch {
    throw new ApiError(422, "signature_pdf_required", "Upload a readable PDF without encryption, XFA or existing digital signatures.");
  }
}

interface Response {
  signer_email: string;
  typed_name: string;
  signed_by: string | null;
  identity_method: string;
  consent_text: string;
  signed_at: Date;
  ip: string | null;
  user_agent: string | null;
  image_png: Buffer | null;
  personal_signature_id: string | null;
}

function printable(text: string, font: PDFFont) {
  return [...text].map((letter) => {
    try {
      font.encodeText(letter);
      return letter;
    } catch {
      return `[U+${letter.codePointAt(0)!.toString(16).toUpperCase()}]`;
    }
  }).join("");
}

export async function writeSignatureEvidence(
  deps: Deps,
  envelope: { id: string; organization_id: string; subject: string | null; documents: EnvDoc[]; sent_at: Date; sent_by: string },
  responses: Response[],
  completedAt: string,
) {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const date = new Date(completedAt);
  pdf.setTitle("Ragsis Sign — Signed documents");
  pdf.setProducer("Ragsis Sign");
  pdf.setCreationDate(date);
  pdf.setModificationDate(date);
  for (const doc of envelope.documents) {
    const bytes = await deps.storage.get(doc.s3_key);
    if (!bytes || sha256(bytes) !== doc.sha256) throw conflict("the signing copy is unavailable or has changed");
    const source = await signaturePdf(bytes);
    for (const page of await pdf.copyPages(source, source.getPageIndices())) pdf.addPage(page);
  }

  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const signatureFont = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const page = pdf.addPage([612, 792]);
  const color = rgb(0.12, 0.16, 0.23);
  page.drawText("RAGSIS SIGN", { x: 48, y: 742, size: 12, font, color });
  page.drawText("Electronic signatures", { x: 48, y: 710, size: 25, font, color });
  page.drawText(`Envelope ${envelope.id}`, { x: 48, y: 687, size: 10, font, color });
  const verifier = printable(`Verify at ${deps.cfg.PUBLIC_BASE_URL.replace(/\/$/, "")}/sign/verify`, font);
  page.drawText(verifier, { x: 48, y: 55, size: Math.min(10, 516 / font.widthOfTextAtSize(verifier, 1)), font, color });
  for (const [index, response] of responses.entries()) {
    const y = 644 - index * 57;
    let x = 48;
    const nameFont = response.image_png ? font : signatureFont;
    if (response.image_png) {
      const image = await pdf.embedPng(response.image_png);
      const size = image.scaleToFit(154, 42);
      page.drawImage(image, { x, y: y - 8 - size.height / 2, ...size });
      x = 222;
    }
    const width = 564 - x;
    const name = printable(response.typed_name, nameFont);
    const size = Math.min(response.image_png ? 13 : 21, width / nameFont.widthOfTextAtSize(name, 1));
    page.drawText(name, { x, y, size, font: nameFont, color });
    const info = printable(`${response.signer_email}  |  ${response.signed_at.toISOString()}`, font);
    page.drawText(info, { x, y: y - 16, size: Math.min(9, width / font.widthOfTextAtSize(info, 1)), font, color });
  }
  const signed = Buffer.from(await pdf.save());
  const signedHash = sha256(signed);
  const manifest = {
    version: 1,
    issuer: "Ragsis Sign",
    envelope_id: envelope.id,
    subject: envelope.subject,
    sent_at: envelope.sent_at.toISOString(),
    approved_by: envelope.sent_by,
    completed_at: completedAt,
    signed_sha256: signedHash,
    documents: envelope.documents.map(({ filename, title, version_id, sha256 }) => ({ filename, title, version_id, sha256 })),
    signers: responses.map(({ image_png, personal_signature_id: _id, signed_at, ...response }) => ({
      ...response, signed_at: signed_at.toISOString(), ...(image_png ? { signature_image_sha256: sha256(image_png) } : {}),
    })),
  };
  const seed = Buffer.from(hkdfSync("sha256", deps.cfg.SIGNATURE_SEAL_SECRET ?? deps.cfg.INTERNAL_SERVICE_SECRET, "", "ragsis-signature-seal-v1", 32));
  const key = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(key).export({ format: "pem", type: "spki" }).toString();
  const payload = Buffer.from(canonical(manifest));
  const certificate = Buffer.from(JSON.stringify({
    manifest, algorithm: "Ed25519", public_key: publicKey, key_id: sha256(publicKey),
    signature: sign(null, payload, key).toString("base64url"),
  }, null, 2));

  const base = `tenants/${envelope.organization_id}/signatures/${envelope.id}/evidence`;
  const certificateHash = sha256(certificate);
  const signedKey = `${base}/${signedHash}.pdf`;
  const certificateKey = `${base}/${certificateHash}.json`;
  await deps.storage.put(signedKey, signed, "application/pdf");
  await deps.storage.put(certificateKey, certificate, "application/json");
  return {
    signed_key: signedKey, signed_filename: "signed.pdf", signed_sha256: signedHash,
    certificate_key: certificateKey, certificate_filename: "signature-certificate.json", certificate_sha256: certificateHash,
    source: "native", stamped: true, key_id: sha256(publicKey),
  };
}
