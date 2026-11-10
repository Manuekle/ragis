import sharp from "sharp";
import { z } from "zod";
import type { Db } from "../db/pool.js";
import { badRequest, notFound } from "./errors.js";

const MAX_IMAGE_BYTES = 448 * 1024;
const PNG_HEADER = Buffer.from("89504e470d0a1a0a", "hex");
const JPEG_HEADER = Buffer.from("ffd8ff", "hex");

export const SignatureImageInput = z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4);
export const SignatureAppearance = z.discriminatedUnion("type", [
  z.object({ type: z.literal("image"), image: SignatureImageInput }).strict(),
  z.object({ type: z.literal("saved"), id: z.uuid() }).strict(),
]);
export type SignatureAppearance = z.infer<typeof SignatureAppearance>;

export async function normalizeSignatureImage(base64: string): Promise<Buffer> {
  const bytes = Buffer.from(base64, "base64");
  const invalid = () => badRequest("Choose a readable PNG or JPEG image for your signature.");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== base64 ||
    (!bytes.subarray(0, PNG_HEADER.length).equals(PNG_HEADER) && !bytes.subarray(0, JPEG_HEADER.length).equals(JPEG_HEADER))) {
    throw invalid();
  }
  try {
    const image = sharp(bytes, { limitInputPixels: 4_000_000 });
    const { format, pages } = await image.metadata();
    if ((format !== "png" && format !== "jpeg") || (pages ?? 1) > 1) throw invalid();
    const png = await image.rotate().resize({ width: 512, height: 192, fit: "inside", withoutEnlargement: true }).png().toBuffer();
    if (png.length > MAX_IMAGE_BYTES) throw invalid();
    return png;
  } catch {
    throw invalid();
  }
}

export async function readPersonalSignature(db: Db, userId: string, id: string): Promise<Buffer> {
  const result = await db.query<{ image_png: Buffer }>(
    "SELECT image_png FROM personal_signatures WHERE id=$1 AND user_id=$2", [id, userId],
  );
  if (!result.rows[0]) throw notFound("saved signature");
  return result.rows[0].image_png;
}
