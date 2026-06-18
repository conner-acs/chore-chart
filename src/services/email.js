import { getOptionalSecret } from "../lib/secrets.js";

// Transactional email with a provider switch (EMAIL_PROVIDER = ses | mailtrap).
// Production uses Amazon SES (IAM-authenticated, co-located with the backend);
// Mailtrap remains for local/dev sandbox capture. Sending is best-effort and
// never throws into the request path (mirrors app/services/email.py).

const cfg = {
  provider: (process.env.EMAIL_PROVIDER || "mailtrap").toLowerCase(),
  senderName: process.env.EMAIL_SENDER_NAME || process.env.MAILTRAP_SENDER_NAME || "SafeDay",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
  environment: process.env.ENVIRONMENT || "development",
  // SES
  sesFrom: process.env.SES_FROM || "",
  sesRegion: process.env.SES_REGION || process.env.AWS_REGION || "ap-southeast-2",
  // Mailtrap
  mailtrapSenderEmail: process.env.MAILTRAP_SENDER_EMAIL || "hello@demomailtrap.co",
  mailtrapSandbox: (process.env.MAILTRAP_SANDBOX || "true").toLowerCase() === "true",
  mailtrapInboxId: process.env.MAILTRAP_INBOX_ID || "",
  mailtrapDevRecipient: process.env.MAILTRAP_DEV_RECIPIENT || "",
};

const isDev = () =>
  ["development", "dev", "local", "test"].includes(cfg.environment.toLowerCase());

// Lazily-created, reused SES client (only when the SES provider is in use).
let _sesClient = null;
async function sesClient() {
  if (_sesClient) return _sesClient;
  const { SESv2Client } = await import("@aws-sdk/client-sesv2");
  _sesClient = new SESv2Client({ region: cfg.sesRegion });
  return _sesClient;
}

// ---- providers ----------------------------------------------------------
// Each returns { sent, messageId?, error? } and never throws.

async function deliverViaSes({ toEmail, subject, text, html }) {
  if (!cfg.sesFrom) {
    return { sent: false, error: "SES_FROM not configured" };
  }
  const from = cfg.senderName ? `${cfg.senderName} <${cfg.sesFrom}>` : cfg.sesFrom;
  try {
    const { SendEmailCommand } = await import("@aws-sdk/client-sesv2");
    const client = await sesClient();
    const out = await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [toEmail] },
        Content: {
          Simple: {
            Subject: { Data: subject },
            Body: {
              Text: { Data: text },
              ...(html ? { Html: { Data: html } } : {}),
            },
          },
        },
      })
    );
    return { sent: true, messageId: out.MessageId };
  } catch (err) {
    console.warn("SES send failed:", err.name, err.message);
    return { sent: false, error: `${err.name}: ${err.message}` };
  }
}

async function deliverViaMailtrap({ toEmail, subject, text, html, category }) {
  const token = await getOptionalSecret("mailtrapApiToken");
  if (!token) return { sent: false, error: "Mailtrap token not configured" };
  if (cfg.mailtrapSandbox && !cfg.mailtrapInboxId) {
    return { sent: false, error: "MAILTRAP_SANDBOX on but MAILTRAP_INBOX_ID unset" };
  }
  const url = cfg.mailtrapSandbox
    ? `https://sandbox.api.mailtrap.io/api/send/${cfg.mailtrapInboxId}`
    : "https://send.api.mailtrap.io/api/send";
  const recipient =
    isDev() && cfg.mailtrapDevRecipient ? cfg.mailtrapDevRecipient : toEmail;
  const payload = {
    from: { email: cfg.mailtrapSenderEmail, name: cfg.senderName },
    to: [{ email: recipient }],
    subject,
    text,
    category,
    ...(html ? { html } : {}),
  };
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Api-Token": token },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) return { sent: false, error: `Mailtrap HTTP ${resp.status}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

// Dispatch to the configured provider. Returns rich detail; never throws.
export async function deliver(msg) {
  const provider = cfg.provider;
  const from = provider === "ses" ? cfg.sesFrom : cfg.mailtrapSenderEmail;
  const result =
    provider === "ses" ? await deliverViaSes(msg) : await deliverViaMailtrap(msg);
  if (result.sent) {
    console.info(`email sent via ${provider} to ${msg.toEmail}: ${msg.subject}`);
  } else {
    console.warn(`email not sent via ${provider} (${result.error}): ${msg.subject}`);
  }
  return { provider, from, to: msg.toEmail, ...result };
}

// Back-compat boolean API used by the request handlers.
export async function sendEmail(msg) {
  return (await deliver(msg)).sent;
}

// Invite a new user to verify their email and set a password. The link carries
// a scoped, single-use token (see lib/auth.createSetPasswordToken).
export async function sendSetPasswordEmail({ toEmail, fullName, token }) {
  const link = `${cfg.publicBaseUrl.replace(/\/$/, "")}/set-password.html?token=${encodeURIComponent(token)}`;
  const firstName = (fullName || "there").split(" ")[0];
  const subject = "Welcome to SafeDay — verify your account & set your password";
  const text =
    `Hi ${firstName},\n\n` +
    "Your SafeDay account has been created. Verify your email and set your " +
    "password using the link below (it expires soon and can only be used once):\n\n" +
    `${link}\n\n` +
    "If you didn't expect this, you can ignore this email.\n\n— The SafeDay team";
  const html =
    `<p>Hi ${firstName},</p>` +
    "<p>Your SafeDay account has been created. Verify your email and set your " +
    "password using the link below (it expires soon and can only be used once):</p>" +
    `<p><a href="${link}">Verify &amp; set your password</a></p>` +
    "<p>If you didn't expect this, you can ignore this email.</p>" +
    "<p>— The SafeDay team</p>";
  return sendEmail({ toEmail, subject, text, html, category: "account-invite" });
}

// Send a diagnostic email to the address stored in the `testEmailTo` secret.
// Used by the /admin/test-email endpoint (and ./test.sh) to verify the email
// pipeline end to end. Returns the delivery detail (never throws).
export async function sendTestEmail() {
  const to = await getOptionalSecret("testEmailTo");
  if (!to) {
    return { sent: false, provider: cfg.provider, error: "testEmailTo secret not set" };
  }
  const stamp = new Date().toISOString();
  return deliver({
    toEmail: to,
    subject: `SafeDay email test (${cfg.environment})`,
    text:
      `This is a SafeDay test email sent at ${stamp} via ${cfg.provider}.\n\n` +
      "If you received this, the production email pipeline is working.",
    html:
      `<p>This is a SafeDay test email sent at <strong>${stamp}</strong> via ` +
      `<strong>${cfg.provider}</strong>.</p>` +
      "<p>If you received this, the production email pipeline is working.</p>",
    category: "diagnostic",
  });
}
