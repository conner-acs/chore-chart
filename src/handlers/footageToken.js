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
  DEFAULT_DEMO_ALERT_TYPE,
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

  // Once footage has lapsed into cold storage it can't be served until restored
  // from Glacier. Surface that distinctly (409) so the client shows the
  // "archived - retrieve to view" message instead of a generic "unavailable".
  const state = alert.footage_state || "hot";
  if (state === "archived" || state === "restoring") {
    throw new HttpError(
      409,
      state === "restoring"
        ? "Footage is being restored from cold storage - try again shortly."
        : "Footage has been archived to cold storage. Retrieve it to view."
    );
  }

  // Resolve the footage prefix from candidates in priority order, using the first
  // that actually has an index.m3u8 in the bucket:
  //   1. real per-alert HLS if packaged (archiver -> MediaConvert follow-up),
  //   2. the demo clip for this alert's type,
  //   3. a default demo clip - so alert types without their own clip
  //      (possibly_staff / incident / ...) still show footage in the demo.
  const candidates = [
    alert.footage_hls_prefix,
    demoHlsPrefix(alert.alert_type),
    demoHlsPrefix(DEFAULT_DEMO_ALERT_TYPE),
  ].filter(Boolean);
  let prefix = null;
  for (const candidate of candidates) {
    if (await hlsExists(candidate)) {
      prefix = candidate;
      break;
    }
  }
  if (!prefix) {
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
