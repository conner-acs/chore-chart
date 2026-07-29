import { getOptionalSecret } from "../lib/secrets.js";

// Transactional email. The provider is chosen by the ENVIRONMENT: any
// environment whose (lower-cased) name CONTAINS "prod" sends via SendGrid,
// authenticated with the `sendgridProdApiToken` secret retrieved from AWS
// Secrets Manager. Every other environment (dev/test/local/staging/…) sends via
// Mailtrap's sandbox for capture. Best-effort — never throws into the request path.

const cfg = {
  senderName: process.env.EMAIL_SENDER_NAME || process.env.MAILTRAP_SENDER_NAME || "SafeDay",
  publicBaseUrl: process.env.PUBLIC_BASE_URL || "http://localhost:3000",
  // Deployed Lambdas set ENVIRONMENT; .env.test uses lowercase `environment`.
  environment: process.env.ENVIRONMENT || process.env.environment || "development",
  // Production sender address (must be a verified SendGrid sender). Reuses SES_FROM.
  fromEmail: process.env.EMAIL_FROM || process.env.SES_FROM || "no-reply@safeday.com.au",
  // Mailtrap (non-prod sandbox capture).
  mailtrapSenderEmail: process.env.MAILTRAP_SENDER_EMAIL || "hello@demomailtrap.co",
  mailtrapSandbox: (process.env.MAILTRAP_SANDBOX || "true").toLowerCase() === "true",
  mailtrapInboxId: process.env.MAILTRAP_INBOX_ID || "",
  mailtrapDevRecipient: process.env.MAILTRAP_DEV_RECIPIENT || "",
};

// Production iff the environment name contains "prod" (prod, production, prod-au…).
const isProdEnv = () => cfg.environment.toLowerCase().includes("prod");

const isDev = () =>
  ["development", "dev", "local", "test"].includes(cfg.environment.toLowerCase());

// ---- providers ----------------------------------------------------------
// Each returns { sent, messageId?, error? } and never throws.

// Production provider: SendGrid v3 Mail Send API, authenticated with the
// `sendgridProdApiToken` secret retrieved from AWS Secrets Manager.
async function deliverViaSendgrid({ toEmail, subject, text, html }) {
  const token = await getOptionalSecret("sendgridProdApiToken");
  if (!token) {
    return { sent: false, error: "SendGrid token (sendgridProdApiToken) not configured" };
  }
  if (!cfg.fromEmail) return { sent: false, error: "sender email not configured" };
  const payload = {
    personalizations: [{ to: [{ email: toEmail }] }],
    from: { email: cfg.fromEmail, name: cfg.senderName },
    subject,
    // SendGrid requires content ordered text/plain before text/html.
    content: [
      { type: "text/plain", value: text },
      ...(html ? [{ type: "text/html", value: html }] : []),
    ],
  };
  try {
    const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (resp.status >= 200 && resp.status < 300) {
      return { sent: true, messageId: resp.headers.get("x-message-id") || undefined };
    }
    const body = await resp.text().catch(() => "");
    return { sent: false, error: `SendGrid HTTP ${resp.status}${body ? `: ${body.slice(0, 300)}` : ""}` };
  } catch (err) {
    return { sent: false, error: err.message };
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

// Choose the provider by environment: "*prod*" -> SendGrid, otherwise Mailtrap.
// Returns rich detail; never throws.
export async function deliver(msg) {
  const prod = isProdEnv();
  const provider = prod ? "sendgrid" : "mailtrap";
  const result = prod ? await deliverViaSendgrid(msg) : await deliverViaMailtrap(msg);

  const from = prod ? cfg.fromEmail : cfg.mailtrapSenderEmail;
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

// Notify a site_admin that their organisation's footage policy changed (SLA days
// and/or restore-approval), including exactly what changed and who changed it.
export async function sendSettingsChangedEmail({ toEmail, fullName, orgName, changes, actorName }) {
  const firstName = (fullName || "there").split(" ")[0];
  const subject = `Footage policy updated - ${orgName}`;
  const lead = `${actorName || "An administrator"} updated the footage policy for ${orgName}.`;
  const text =
    `Hi ${firstName},\n\n${lead}\n\n` +
    changes.map((c) => `- ${c}`).join("\n") +
    `\n\n- SafeDay`;
  const html =
    `<p>Hi ${escHtml(firstName)},</p><p>${escHtml(lead)}</p><ul>` +
    changes.map((c) => `<li>${escHtml(c)}</li>`).join("") +
    `</ul><p>- SafeDay</p>`;
  return sendEmail({ toEmail, subject, text, html, category: "settings-change" });
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
