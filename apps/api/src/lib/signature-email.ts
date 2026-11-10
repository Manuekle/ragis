import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Config } from "../config.js";

export type SignatureMailKind = "invitation" | "completed";
export type SignatureMailer = (to: string, url: string, kind: SignatureMailKind) => Promise<void>;

export function createSignatureMailer(cfg: Config): SignatureMailer | undefined {
  const from = cfg.SIGNATURE_EMAIL_FROM;
  if (!from) return undefined;
  const client = new SESv2Client({ region: cfg.AWS_REGION });
  return async (to, url, kind) => {
    const completed = kind === "completed";
    await client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: { Simple: {
        Subject: { Data: completed ? "Ragsis Sign · Document signed" : "Ragsis Sign · Signature requested", Charset: "UTF-8" },
        Body: { Text: { Data: `${completed ? "All signatures have been collected. Open your link to download the signed PDF:" : "A document is ready for your review and signature in Ragsis. Open your personal invitation:"}\n\n${url}\n\nThis link grants access to the document. Keep it private. If you were not expecting this request, you can ignore this message.`, Charset: "UTF-8" } },
      } },
    }), { abortSignal: AbortSignal.timeout(10_000) });
  };
}
