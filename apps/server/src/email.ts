// SMTP email sending (OTC codes, billing receipts). Configured via SMTP_* env vars
// (e.g. Proton Mail SMTP). If unconfigured, sends are console-logged in dev mode so
// the signup/OTC flow is fully testable without an SMTP server — the transport is
// built lazily so the server boots fine with no mail config at all.
import nodemailer, { type Transporter } from 'nodemailer';

const SMTP_HOST = process.env.SMTP_HOST?.trim() || '';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 587;
const SMTP_USER = process.env.SMTP_USER?.trim() || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM = process.env.SMTP_FROM?.trim() || SMTP_USER;
// Port 465 is implicit TLS; 587/25 use STARTTLS. Override with SMTP_SECURE=1/0.
const SMTP_SECURE =
  process.env.SMTP_SECURE != null ? process.env.SMTP_SECURE === '1' : SMTP_PORT === 465;

const APP_NAME = 'Carbon';

export function isEmailConfigured(): boolean {
  return !!(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM);
}

let transport: Transporter | null = null;
function getTransport(): Transporter {
  if (!transport) {
    transport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });
  }
  return transport;
}

/**
 * Send an email. When SMTP isn't configured, log it to the console (dev mode) and
 * return so callers don't need to special-case local development. Throws if a
 * configured transport actually fails.
 */
export async function sendEmail(
  to: string,
  subject: string,
  text: string,
  html?: string,
): Promise<void> {
  if (!isEmailConfigured()) {
    console.log(
      `[carbon][email:dev] (SMTP not configured) to=${to}\n  subject: ${subject}\n  ${text.replace(/\n/g, '\n  ')}`,
    );
    return;
  }
  await getTransport().sendMail({ from: SMTP_FROM, to, subject, text, html });
}

/** Email a one-time signup verification code. */
export async function sendOtcCode(to: string, code: string): Promise<void> {
  const subject = `Your ${APP_NAME} verification code`;
  const text =
    `Your ${APP_NAME} workspace verification code is:\n\n  ${code}\n\n` +
    `Enter it on the signup page to finish creating your workspace. ` +
    `The code expires shortly. If you didn't request this, you can ignore this email.`;
  await sendEmail(to, subject, text);
}

/** Email a billing receipt after a successful subscription/renewal. */
export async function sendBillingReceipt(
  to: string,
  planLabel: string,
  newExpiry: string,
): Promise<void> {
  const until = new Date(newExpiry).toLocaleDateString();
  const subject = `${APP_NAME} subscription confirmed`;
  const text =
    `Thanks — your ${APP_NAME} subscription is active.\n\n` +
    `  Plan: ${planLabel}\n  Access through: ${until}\n\n` +
    `Your workspace will keep syncing until then.`;
  await sendEmail(to, subject, text);
}
