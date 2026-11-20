import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Config } from "../config.js";

/** What an invitation email says: who invites, to which organization, and where to sign in. */
export interface MemberInvite {
  to: string;
  organization: string;
  invitedBy: string;
  signInUrl: string;
  locale: "es" | "en";
}
export type MemberMailer = (invite: MemberInvite) => Promise<void>;

const COPY = {
  es: (i: MemberInvite) => ({
    subject: `${i.invitedBy} te invitó a ${i.organization} en Ragis`,
    body:
      `${i.invitedBy} te invitó a unirte a ${i.organization} en Ragis.\n\n` +
      `Inicia sesión con este correo (${i.to}) y entrarás directamente a la organización:\n\n${i.signInUrl}\n\n` +
      "Si todavía no tienes cuenta, pide a quien te invitó que te la cree. La invitación caduca en 14 días. " +
      "Si no esperabas este mensaje, puedes ignorarlo.",
  }),
  en: (i: MemberInvite) => ({
    subject: `${i.invitedBy} invited you to ${i.organization} on Ragis`,
    body:
      `${i.invitedBy} invited you to join ${i.organization} on Ragis.\n\n` +
      `Sign in with this email (${i.to}) and you'll go straight into the organization:\n\n${i.signInUrl}\n\n` +
      "If you don't have an account yet, ask the person who invited you to create one. The invitation expires in 14 days. " +
      "If you weren't expecting this message, you can ignore it.",
  }),
};

/** Same verified SES sender as Ragsis Sign (SIGNATURE_EMAIL_FROM). Without it, invitations work but send nothing. */
export function createMemberMailer(cfg: Config): MemberMailer | undefined {
  const from = cfg.SIGNATURE_EMAIL_FROM;
  if (!from) return undefined;
  const client = new SESv2Client({ region: cfg.AWS_REGION });
  return async (invite) => {
    const { subject, body } = COPY[invite.locale](invite);
    await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [invite.to] },
        Content: { Simple: { Subject: { Data: subject, Charset: "UTF-8" }, Body: { Text: { Data: body, Charset: "UTF-8" } } } },
      }),
      { abortSignal: AbortSignal.timeout(10_000) },
    );
  };
}
