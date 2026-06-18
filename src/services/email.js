import { getOptionalSecret } from "../lib/secrets.js";

// Transactional email via Mailtrap's HTTP API. When the API token is unset the
// send is a no-op, so the app runs fine without email configured (mirrors
// app/services/email.py). Best-effort: never throws into the request path.

const SANDBOX_URL = "https://sandbox.api.mailtrap.io/api/send/{inbox_id}";
const SEND_URL = "https://send.api.mailtrap.io/api/send";

const cfg = {
  senderEmail: process.env.MAILTRAP_SENDER_EMAIL || "hello@demomailtrap.co",
  senderName: process.env.MAILTRAP_SENDER_NAME || "SafeDay",
  sandbox: (process.env.MAILTRAP_SANDBOX || "true").toLowerCase() === "true",
  inboxId: process.env.MAILTRAP_INBOX_ID || "",
  devRecipient: process.env.MAILTRAP_DEV_RECIPIENT || "",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
  environment: process.env.ENVIRONMENT || "development",
};

const isDev = () =>
  ["development", "dev", "local", "test"].includes(cfg.environment.toLowerCase());

async function endpoint(token) {
  if (!token) return null;
  if (cfg.sandbox) {
    if (!cfg.inboxId) {
      console.warn("MAILTRAP_SANDBOX on but MAILTRAP_INBOX_ID unset; skipping email");
      return null;
    }
    return SANDBOX_URL.replace("{inbox_id}", cfg.inboxId);
  }
  return SEND_URL;
}

export async function sendEmail({ toEmail, subject, text, html, category = "transactional" }) {
  const token = await getOptionalSecret("mailtrapApiToken");
  const url = await endpoint(token);
  if (!url) {
    console.info("email send skipped (Mailtrap not configured):", subject);
    return false;
  }
  const recipient = isDev() && cfg.devRecipient ? cfg.devRecipient : toEmail;
  const payload = {
    from: { email: cfg.senderEmail, name: cfg.senderName },
    to: [{ email: recipient }],
    subject,
    text,
    category,
  };
  if (html) payload.html = html;

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Api-Token": token },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      console.warn(`Mailtrap send failed (${resp.status})`);
      return false;
    }
    console.info("email sent to", recipient, "subject:", subject);
    return true;
  } catch (err) {
    console.warn("Mailtrap send errored:", err.message);
    return false;
  }
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
