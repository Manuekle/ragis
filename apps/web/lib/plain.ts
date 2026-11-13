// Plain-language helpers: turn internal codes into words people outside engineering understand.

/** "document.rejected" / "WORKFLOW_RUN_STARTED" / "max_steps" → "Document rejected" / "Workflow run started" / "Max steps". */
export function humanize(code: string): string {
  const s = code.replace(/[._:-]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return s ? s[0]!.toUpperCase() + s.slice(1) : code;
}

/** Response time without milliseconds. */
export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.max(0.1, ms / 1000);
  return s < 60 ? `${s.toFixed(1)} s` : `${Math.round(s / 60)} min`;
}

export const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Why a document couldn't be processed, from the ingest worker's error codes. */
const DOC_ERRORS: Record<string, string> = {
  too_large: "File is larger than your plan allows",
  page_limit: "Too many pages for your plan",
  image_too_large: "Image is too large",
  empty_file: "The file is empty",
  encrypted_file: "File is password-protected — remove the password and upload again",
  corrupt_pdf: "The PDF looks damaged — try exporting it again",
  corrupt_archive: "The file looks damaged — try saving it again",
  corrupt_image: "The image looks damaged",
  bad_encoding: "The text encoding couldn't be read",
  unsupported_type: "This file type isn't supported",
  mime_mismatch: "The file's content doesn't match its extension",
  size_mismatch: "The upload didn't finish — try again",
  macro_document: "Files with macros aren't allowed for safety",
  embedded_executable: "The file contains a program and was blocked for safety",
  malware_detected: "Blocked: the file looks unsafe",
  zip_bomb: "Blocked: the file looks unsafe",
  zip_path_traversal: "Blocked: the file looks unsafe",
  no_extractable_text: "No readable text found",
  ocr_required: "Scanned file — text recognition isn't available on your plan",
  model_policy_violation: "Your data policy doesn't allow processing this file",
  transcription_required: "Recording — turning speech into text isn't switched on for this workspace yet",
  no_speech_detected: "No speech could be heard in this recording",
  audio_too_long: "The recording is too long — split it into shorter parts",
  dead_letter: "Processing failed several times — try uploading again",
};
const IMAGE = /\.(png|jpe?g)$/i;
// The same code reads differently per format: an image with no text is a photo, not a broken file.
const IMAGE_ERRORS: Record<string, string> = {
  no_extractable_text: "No text found in this image — photos without text need image descriptions switched on",
  ocr_required: "Reading text in images isn't switched on for this workspace yet",
};
export const docError = (code: string, filename?: string) =>
  (filename && IMAGE.test(filename) ? IMAGE_ERRORS[code] : undefined) ?? DOC_ERRORS[code] ?? "Couldn't process this file — try uploading again";
