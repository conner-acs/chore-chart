import { getOptionalSecret } from "../lib/secrets.js";

// Transactional email with a provider switch (EMAIL_PROVIDER = ses | mailtrap).
// Production uses Amazon SES (IAM-authenticated, co-located with the backend);
// Mailtrap remains for local/dev sandbox capture. Sending is best-effort and
// never throws into the request path (mirrors app/services/email.py).
//
// Resilience: when SES is the primary provider and a send fails (e.g. the
// sending domain isn't DKIM-verified yet, or SES is throttled/down), delivery
// automatically FALLS BACK to Mailtrap so transactional mail — invites, password
// resets, alerts — still goes out. Requires mailtrapApiToken to be configured;
// otherwise both providers report failure and the caller sees sent: false.

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

// Dispatch to the configured provider, falling back to Mailtrap if SES fails.
// Returns rich detail; never throws.
export async function deliver(msg) {
  const primary = cfg.provider;
  let provider = primary;
  let result =
    primary === "ses" ? await deliverViaSes(msg) : await deliverViaMailtrap(msg);

  // SES → Mailtrap fallback: keep mail flowing while SES/DKIM is unavailable.
  if (!result.sent && primary === "ses") {
    console.warn(
      `email via ses failed (${result.error}); falling back to mailtrap: ${msg.subject}`
    );
    const fallback = await deliverViaMailtrap(msg);
    if (fallback.sent) {
      result = { ...fallback, fellBackFrom: "ses", sesError: result.error };
      provider = "mailtrap";
    } else {
      // Both failed — surface both errors so the cause is diagnosable.
      result = { sent: false, error: `ses: ${result.error}; mailtrap: ${fallback.error}` };
      provider = "ses+mailtrap";
    }
  }

  const from = provider === "mailtrap" ? cfg.mailtrapSenderEmail : cfg.sesFrom;
  if (result.sent) {
    const via = result.fellBackFrom ? `${provider} (fallback from ${result.fellBackFrom})` : provider;
    console.info(`email sent via ${via} to ${msg.toEmail}: ${msg.subject}`);
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

// User-initiated password reset. Reuses the same scoped, single-use set-password
// token + /set-password.html page as the invite flow — only the copy differs.
export async function sendPasswordResetEmail({ toEmail, fullName, token }) {
  const link = `${cfg.publicBaseUrl.replace(/\/$/, "")}/set-password.html?token=${encodeURIComponent(token)}`;
  const firstName = escHtml((fullName || "there").split(" ")[0]);
  const subject = "Reset your SafeDay password";
  const text =
    `Hi ${firstName},\n\n` +
    "We received a request to reset your SafeDay password. Use the link below to " +
    "choose a new one (it expires soon and can only be used once):\n\n" +
    `${link}\n\n` +
    "If you didn't request this, you can safely ignore this email — your password " +
    "won't change.\n\n— The SafeDay team";
  const html =
    `<p>Hi ${firstName},</p>` +
    "<p>We received a request to reset your SafeDay password. Use the link below to " +
    "choose a new one (it expires soon and can only be used once):</p>" +
    `<p><a href="${link}">Reset your password</a></p>` +
    "<p>If you didn't request this, you can safely ignore this email — your password " +
    "won't change.</p>" +
    "<p>— The SafeDay team</p>";
  return sendEmail({ toEmail, subject, text, html, category: "password-reset" });
}

function escHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );
}
function prettyLabel(l) {
  return l ? String(l).replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) : "";
}

// Notify a site admin that an alert needs their attention — either a fresh
// escalation (an operator submitted it for review) or a conflict (a second
// operator disagreed, so it now needs an admin's final decision). Best-effort.
// @param {{toEmail,fullName,kind:"escalation"|"conflict",alert,siteName,actorName}}
export async function sendAlertReviewEmail({
  toEmail,
  fullName,
  kind,
  alert,
  siteName,
  actorName,
}) {
  const isConflict = kind === "conflict";
  const firstName = (fullName || "there").split(" ")[0];
  const type = prettyLabel(alert.alert_type) || "Alert";
  const link = `${cfg.publicBaseUrl.replace(/\/$/, "")}/command/${encodeURIComponent(alert.id)}`;
  const subject = isConflict
    ? `Action needed — conflicting review at ${siteName}`
    : `Alert escalated for review — ${siteName}`;
  const lead = isConflict
    ? `A second operator disagreed with the proposed decision on a ${type} alert at ${siteName}. It needs a site administrator to make the final call.`
    : `${actorName || "An operator"} escalated a ${type} alert at ${siteName} for review.`;

  const facts = [
    ["Site", siteName],
    ["Alert type", type],
    ["Camera", alert.camera_id || "—"],
    ["Raised", alert.created_at],
    ["Proposed decision", prettyLabel(alert.proposer_label) || "—"],
  ];
  if (isConflict) {
    facts.push(["Disputed by", actorName || "—"]);
    facts.push(["Disputed as", prettyLabel(alert.review_label) || "—"]);
    if (alert.review_note) facts.push(["Reviewer note", alert.review_note]);
  } else {
    facts.push(["Escalated by", actorName || "—"]);
  }

  const text =
    `Hi ${firstName},\n\n${lead}\n\n` +
    facts.map(([k, v]) => `${k}: ${v}`).join("\n") +
    `\n\nReview it: ${link}\n\n— SafeDay`;
  const html =
    `<p>Hi ${escHtml(firstName)},</p><p>${escHtml(lead)}</p><ul>` +
    facts.map(([k, v]) => `<li><strong>${escHtml(k)}:</strong> ${escHtml(v)}</li>`).join("") +
    `</ul><p><a href="${escHtml(link)}">Open the alert</a></p><p>— SafeDay</p>`;

  return sendEmail({ toEmail, subject, text, html, category: "alert-review" });
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
