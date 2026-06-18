import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId, nowIso } from "../lib/ids.js";
import { getSecret } from "../lib/secrets.js";
import { getSiteByToken } from "../lib/repo/sites.js";
import { putAlert } from "../lib/repo/alerts.js";
import { broadcastAlert } from "../services/notifications.js";
import { alertResponse } from "../lib/presenters.js";
import { webhookAlertSchema } from "../schemas/index.js";

// Receive a new alert from the CV pipeline. Authenticated by the shared
// X-Webhook-Secret header (not JWT) — the caller is the Nx plugin, not an operator.
async function receiveAlert({ event, body }) {
  const provided =
    event.headers?.["x-webhook-secret"] || event.headers?.["X-Webhook-Secret"];
  const expected = await getSecret("webhookSecret");
  if (!provided || provided !== expected) {
    throw new HttpError(401, "Invalid webhook secret");
  }

  const site = await getSiteByToken(body.site_token);
  if (!site) throw new HttpError(422, "Invalid request"); // unknown site_token

  const alert = {
    id: newId(),
    site_id: site.id,
    camera_id: body.camera_id,
    alert_type: body.alert_type,
    start_timestamp: new Date(body.start_timestamp).toISOString(),
    end_timestamp: new Date(body.end_timestamp).toISOString(),
    nx_bookmark_id: body.nx_bookmark_id ?? null,
    status: "unprocessed",
    decided_by: null,
    decided_at: null,
    decision_label: null,
    created_at: nowIso(),
  };
  await putAlert(alert);

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
