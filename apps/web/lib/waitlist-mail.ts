import "server-only";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

/**
 * The email that confirms a waitlist sign-up, sent with Amazon SES like the app's signature
 * invitations (apps/api/src/lib/signature-email.ts).
 *
 *   email: WAITLIST_EMAIL_FROM is set (a sender verified in SES). The link goes by email.
 *   test:  WAITLIST_EMAIL_TEST=1 and no sender. Nothing is sent; the link is written to the
 *          server log and shown on the page, so the whole flow can be tried on a laptop.
 *   off:   neither. Sign-ups are saved at once, without confirming the email.
 */
export type ConfirmMode = "email" | "test" | "off";

export function confirmMode(): ConfirmMode {
  if (process.env.WAITLIST_EMAIL_FROM) return "email";
  return process.env.WAITLIST_EMAIL_TEST === "1" ? "test" : "off";
}

let client: SESv2Client | undefined;

const escape = (text: string) => text.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch);

/** Sends the confirmation link. Throws when SES refuses or does not answer in ten seconds. */
export async function sendConfirmEmail(to: string, url: string): Promise<void> {
  const from = process.env.WAITLIST_EMAIL_FROM;
  if (!from) throw new Error("WAITLIST_EMAIL_FROM is not set");
  // Region and credentials come from the environment (AWS_REGION and the server's own role).
  client ??= new SESv2Client({});
  const text = [
    "Confirm your email to save your place on the Ragis waitlist and open your badge:",
    "",
    url,
    "",
    "The link works for 24 hours and only once. If you didn't ask to join, ignore this email and nothing happens.",
  ].join("\n");
  const href = escape(url);
  const html = `<!doctype html><html><body style="margin:0;padding:32px 16px;background:#eeeef0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#fbfbfc;border-radius:20px;border:1px solid #e4e4e7"><tr><td style="padding:32px">
<p style="margin:0 0 24px;font-size:20px;font-family:Georgia,'Times New Roman',serif">Ragis</p>
<p style="margin:0 0 8px;font-size:22px;line-height:1.25">Confirm your place on the waitlist</p>
<p style="margin:0 0 24px;font-size:15px;line-height:1.55;color:#52525b">One click saves your place and opens your badge.</p>
<p style="margin:0 0 24px"><a href="${href}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#0a84ff;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none">Confirm my email</a></p>
<p style="margin:0 0 6px;font-size:13px;line-height:1.5;color:#68686f">Or open this link:</p>
<p style="margin:0 0 24px;font-size:13px;line-height:1.5;word-break:break-all"><a href="${href}" style="color:#0068d6">${href}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:#68686f">The link works for 24 hours and only once. If you didn't ask to join, ignore this email and nothing happens.</p>
</td></tr></table></td></tr></table></body></html>`;

  await client.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: "Confirm your place on the Ragis waitlist", Charset: "UTF-8" },
          Body: { Text: { Data: text, Charset: "UTF-8" }, Html: { Data: html, Charset: "UTF-8" } },
        },
      },
    }),
    { abortSignal: AbortSignal.timeout(10_000) },
  );
}
