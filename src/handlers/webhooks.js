import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId, nowIso } from "../lib/ids.js";
import { getSecret } from "../lib/secrets.js";
import { getSiteByToken } from "../lib/repo/sites.js";
import { putAlert } from "../lib/repo/alerts.js";
import { demoHlsPrefix } from "../lib/footageArchive.js";
import { broadcastAlert } from "../services/notifications.js";
import { alertResponse } from "../lib/presenters.js";
import { webhookAlertSchema } from "../schemas/index.js";

// The SHOGUN plugin's exact alert_type string is version-dependent, so normalise
// known aliases to the canonical label the frontend's Alert-Type filter expects
// (workflowConfig.js ids, lowercased). Unknown values pass through unchanged and
// are logged, so no alert is ever dropped over a naming mismatch.
const ALERT_TYPE_ALIASES = {
  // Adult alone with a child -> canonical "child_alone_with_adult"
  person_alone_with_child: "child_alone_with_adult",
  adult_alone_with_child: "child_alone_with_adult",
  reidaloneadultevent: "child_alone_with_adult",
  reidaloneadultobject: "child_alone_with_adult",
  "nx.aol_shogun.reidaloneadultevent": "child_alone_with_adult",
  // Child alone -> canonical "child_alone"
  reidalonechildevent: "child_alone",
  "nx.aol_shogun.reidalonechildevent": "child_alone",
};
function normalizeAlertType(raw) {
  const key = String(raw ?? "").toLowerCase().trim();
  return ALERT_TYPE_ALIASES[key] || raw;
}

// Receive a new alert from the CV pipeline. Authenticated by the shared
// X-Webhook-Secret header (not JWT) — the caller is the Nx plugin, not an operator.
// Exported so the "Send test alert" admin action can invoke the real webhook
// path in-process (secret check + site_token resolution + putAlert + broadcast)
// rather than duplicating alert creation.
export async function receiveAlert({ event, body }) {
  // Auth: prefer the X-Webhook-Secret header; fall back to a `webhook_secret`
  // (or `secret`) query parameter. The query-param fallback exists because some
  // Nx Witness versions (e.g. 6.0.1) can't send custom HTTP headers from an
  // event rule — they can only put the secret in the URL. It's sent over HTTPS
  // to our endpoint and is still rotatable; use the header when the caller (e.g.
  // the SafeDay plugin) can set one.
  const q = event.queryStringParameters || {};
  const provided =
    event.headers?.["x-webhook-secret"] ||
    event.headers?.["X-Webhook-Secret"] ||
    q.webhook_secret ||
    q.secret;
  const expected = await getSecret("webhookSecret");
  if (!provided || provided !== expected) {
    throw new HttpError(401, "Invalid webhook secret");
  }

  const site = await getSiteByToken(body.site_token);
  if (!site) throw new HttpError(422, "Invalid request"); // unknown site_token

  // Log the raw payload shape so the first live plugin alert reveals exactly what
  // SHOGUN sends (alert_type/camera/timestamps) — useful for tuning the aliases.
  const alertType = normalizeAlertType(body.alert_type);
  console.info(
    "receiveAlert: site=%s raw_alert_type=%j -> %s camera=%j start=%j",
    body.site_token, body.alert_type, alertType, body.camera_id, body.start_timestamp
  );

  const alert = {
    id: newId(),
    site_id: site.id,
    camera_id: body.camera_id,
    alert_type: alertType,
    start_timestamp: new Date(body.start_timestamp).toISOString(),
    end_timestamp: new Date(body.end_timestamp).toISOString(),
    nx_bookmark_id: body.nx_bookmark_id ?? null,
    status: "unprocessed",
    decided_by: null,
    decided_at: null,
    decision_label: null,
    created_at: nowIso(),
    // Footage starts HOT, wired to this alert type's seeded demo HLS clip (see
    // demoHlsPrefix + tools/transcode-demo-footage.mjs), so the footage-token
    // endpoint resolves it immediately after the alert is generated. The archiver
    // moves it to cold storage (footage_state -> "archived") once the org's SLA
    // retention window lapses.
    footage_state: "hot",
    footage_hls_prefix: demoHlsPrefix(alertType),
  };
  await putAlert(alert);
  // Traceable log so a test/live alert is greppable in CloudWatch by id.
  console.info("receiveAlert: created alert", alert.id, "for site", site.id);

  // Fan out to connected operators/superusers. Best-effort — never block the
  // 201 on a notification failure.
  try {
    await broadcastAlert(alert.id, site.id);
  } catch (err) {
    console.warn("broadcastAlert failed:", err.message);
  }

  return alertResponse(alert);
}

export const handler = createRouter({
  "POST /api/v1/webhooks/alert": {
    fn: receiveAlert,
    schema: webhookAlertSchema,
    status: 201,
  },
});
