import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId, nowIso } from "../lib/ids.js";
import { getAlert } from "../lib/repo/alerts.js";
import { userCanAccessSite } from "../lib/permissions.js";
import { operatorCanSeeAlert } from "../lib/alertAccess.js";
import { putFootageLog } from "../lib/repo/footageLog.js";
import {
  demoHlsPrefix,
  hlsExists,
  buildSignedManifest,
  FOOTAGE_TOKEN_TTL_SEC,
} from "../lib/footageArchive.js";

// Mint a short-lived footage token for an alert: re-run the SAME per-alert
// authorization the rest of the app enforces, write the audit row, then return a
// signed HLS manifest whose segments are presigned S3 URLs (~15min, in-region).
// The player feeds this manifest to hls.js as a blob, so no single downloadable
// video URL ever reaches the DOM (the presigned segments are the short-lived
// tokens). Everything stays in ap-southeast-2 - no CDN, no offshore edge.
//
// SECURITY_DECISIONS: the partner-email gate (assertFootageEmailAllowed, used by
// /footage/history) is intentionally NOT applied here - it lists the partner
// review orgs, and applying it would 403 the centre operators who are authorised
// to see their own footage. Alert-footage authz = site access + operator
// visibility, identical to the streaming handler.
async function mintFootageToken({ user, params }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (user.role === "operator" && !operatorCanSeeAlert(alert)) {
    throw new HttpError(403, "Access denied");
  }

  // Pick the footage prefix: real per-alert HLS if packaged, else the demo clip
  // for this alert's type. (Real per-alert HLS packaging lands with the archiver
  // -> MediaConvert follow-up; today the demo prefix is what's populated.)
  let prefix = alert.footage_hls_prefix || null;
  if (!prefix) {
    const demo = demoHlsPrefix(alert.alert_type);
    if (await hlsExists(demo)) prefix = demo;
  }
  if (!prefix || !(await hlsExists(prefix))) {
    throw new HttpError(404, "No footage available for this alert");
  }

  // Audit BEFORE issuing, so the access is recorded even if signing later fails.
  await putFootageLog({
    id: newId(),
    alert_id: alert.id,
    site_id: alert.site_id,
    camera_id: alert.camera_id,
    alert_type: alert.alert_type,
    user_id: user.id,
    user_email: user.email,
    user_full_name: user.full_name,
    action: "clip_viewed",
    accessed_at: nowIso(),
  });

  const manifest = await buildSignedManifest(prefix);
  return { manifest, expires_in: FOOTAGE_TOKEN_TTL_SEC };
}

export const handler = createRouter({
  "POST /api/v1/alerts/{alert_id}/footage-token": {
    fn: mintFootageToken,
    auth: "user",
  },
});
