import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { Config } from "../config.js";
import type { ReminderKind } from "./deadlines.js";

/**
 * Reminder emails for deadlines (ADR-037). Same SES path and sender as signature invitations (SIGNATURE_EMAIL_FROM):
 * without it no reminder is sent, and the web says so on the Términos page.
 */
export interface DeadlineReminder {
  to: string;
  name: string | null;
  kind: ReminderKind;
  title: string;
  dueOn: string;
  organization: string;
  legalBasis: string;
  documentTitle: string | null;
  page: number | null;
  url: string;
}
export type DeadlineMailer = (reminder: DeadlineReminder) => Promise<void>;

const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "jueves 19 de noviembre de 2026" */
export function longDateEs(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]} de ${d.getUTCFullYear()}`;
}

const SUBJECT: Record<ReminderKind, string> = {
  week: "vence en una semana",
  two_days: "vence en dos días hábiles",
  due: "vence hoy",
  overdue: "venció sin marcarse como cumplido",
};

export function reminderText(r: DeadlineReminder): { subject: string; body: string } {
  const subject = `Ragis · Término ${SUBJECT[r.kind]}: ${r.title}`.slice(0, 200);
  const source = r.documentTitle ? `Fuente: ${r.documentTitle}${r.page ? `, página ${r.page}` : ""}` : null;
  const lines = [
    r.name ? `Hola, ${r.name}:` : "Hola:",
    "",
    r.kind === "overdue"
      ? `El término «${r.title}» venció el ${longDateEs(r.dueOn)} y sigue pendiente en Ragis.`
      : `El término «${r.title}» ${SUBJECT[r.kind]}: ${longDateEs(r.dueOn)}.`,
    "",
    `Firma: ${r.organization}`,
    ...(r.legalBasis ? [`Norma: ${r.legalBasis}`] : []),
    ...(source ? [source] : []),
    "",
    "Revisa el cómputo y márcalo como cumplido cuando radiques:",
    r.url,
    "",
    "Recibes este correo porque eres la persona responsable de este término. El cómputo lo hace Ragis con los festivos y la vacancia judicial que tu firma configuró; verifícalo antes de actuar.",
  ];
  return { subject, body: lines.join("\n") };
}

export function createDeadlineMailer(cfg: Config): DeadlineMailer | undefined {
  const from = cfg.SIGNATURE_EMAIL_FROM;
  if (!from) return undefined;
  const client = new SESv2Client({ region: cfg.AWS_REGION });
  return async (r) => {
    const { subject, body } = reminderText(r);
    await client.send(new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [r.to] },
      Content: { Simple: {
        Subject: { Data: subject, Charset: "UTF-8" },
        Body: { Text: { Data: body, Charset: "UTF-8" } },
      } },
    }), { abortSignal: AbortSignal.timeout(10_000) });
  };
}
