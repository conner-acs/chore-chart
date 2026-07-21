import { pipeline } from "stream/promises";
import { getCurrentUser } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId, nowIso } from "../lib/ids.js";
import { decryptNxPassword } from "../lib/fernet.js";
import { userCanAccessSite } from "../lib/permissions.js";
import { operatorCanSeeAlert } from "../lib/alertAccess.js";
import { assertFootageEmailAllowed } from "../lib/footageAccess.js";
import { getAlert } from "../lib/repo/alerts.js";
import { getSite } from "../lib/repo/sites.js";
import { putFootageLog } from "../lib/repo/footageLog.js";
import { getOrgNxCredentials } from "../lib/secrets.js";
import { NxWitnessClient, NxWitnessError } from "../services/nxWitness.js";

// Footage Lambda Function URL (RESPONSE_STREAM). Two paths hit this one handler:
//
//   GET /footage/{alert_id}                       -> the clip for an existing alert
//   GET /footage/history?site_id&camera_id&start  -> an arbitrary archive clip
//
// It is a Function URL (not API Gateway) so it can stream MP4 chunks past the
// 10 MB / 29 s API Gateway limits. `awslambda` is a runtime global; CORS is set
// on the Function URL (serverless.yml url.cors).

// Footage-history window limits. Clips default to 60s — the standard alert clip
// length across the backend, seed data, and the production architecture brief —
// and are capped so a single request can't pull an unbounded archive export.
const DEFAULT_DURATION_MS = 60 * 1000;
const MAX_WINDOW_MS = 10 * 60 * 1000;

function toMs(v) {
  if (v == null || v === "") return null;
  if (/^\d+$/.test(String(v))) return Number(v);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

// Resolve start/end (epoch ms) from query: `start` (ISO-8601 or epoch ms) is
// required; `end` or `duration` (seconds) is optional, defaulting to 60s.
function parseWindow(q) {
  const startMs = toMs(q.start);
  if (startMs == null) {
    throw new HttpError(400, "start is required (ISO-8601 or epoch ms)");
  }
  let endMs = toMs(q.end);
  if (endMs == null) {
    const durMs = q.duration ? Number(q.duration) * 1000 : DEFAULT_DURATION_MS;
    if (!Number.isFinite(durMs) || durMs <= 0) {
      throw new HttpError(400, "duration must be a positive number of seconds");
    }
    endMs = startMs + durMs;
  }
  if (endMs <= startMs) throw new HttpError(400, "end must be after start");
  if (endMs - startMs > MAX_WINDOW_MS) {
    throw new HttpError(400, "requested window exceeds the 10 minute limit");
  }
  return { startMs, endMs };
}

// GET /footage/history — stream an archived clip for a camera + time window.
// Auth flow, as requested: SafeDay bearer token -> resolve user -> restrict to
// approved footage domains -> confirm the user can access the site -> look up
// that organization's Nx credentials in Secrets Manager -> stream the clip.
async function resolveHistoryStream(event) {
  const q = event.queryStringParameters || {};
  const siteId = q.site_id;
  const cameraId = q.camera_id;
  if (!siteId || !cameraId) {
    throw new HttpError(400, "site_id and camera_id are required");
  }
  const { startMs, endMs } = parseWindow(q);

  const user = await getCurrentUser(event); // throws HttpError 401
  assertFootageEmailAllowed(user); // 403 unless on an approved footage domain
  if (!(await userCanAccessSite(user, siteId))) {
    throw new HttpError(403, "Access denied");
  }

  const site = await getSite(siteId);
  if (!site) throw new HttpError(404, "Site not found");

  const creds = await getOrgNxCredentials(site.organization_id);
  if (!creds) {
    throw new HttpError(502, "No Nx credentials configured for this organization");
  }

  // Audit the access before streaming — logged even if the client disconnects.
  await putFootageLog({
    id: newId(),
    alert_id: null,
    site_id: siteId,
    camera_id: cameraId,
    alert_type: null,
    user_id: user.id,
    user_email: user.email,
    user_full_name: user.full_name,
    action: "history_clip_viewed",
    accessed_at: nowIso(),
    window_start: new Date(startMs).toISOString(),
    window_end: new Date(endMs).toISOString(),
  });

  try {
    const client = new NxWitnessClient({
      host: site.nx_host,
      username: creds.username,
      password: creds.password,
      tlsCert: site.nx_tls_cert,
    });
    const stream = await client.exportClipStream(cameraId, startMs, endMs);
    return { stream, filename: `history-${cameraId}-${startMs}.mp4` };
  } catch (err) {
    if (err instanceof NxWitnessError) {
      throw new HttpError(502, `Failed to retrieve clip from Nx Witness: ${err.message}`);
    }
    throw new HttpError(502, "Failed to retrieve clip from Nx Witness: upstream unreachable");
  }
}

async function resolveClipStream(event) {
  // Function URLs have no path templating — take the last path segment.
  const path = event.rawPath || event.requestContext?.http?.path || "";
  const alertId = decodeURIComponent(path.split("/").filter(Boolean).pop() || "");

  const user = await getCurrentUser(event); // throws HttpError 401
  const alert = await getAlert(alertId);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (user.role === "operator" && !operatorCanSeeAlert(alert)) {
    throw new HttpError(
      403,
      "Operators can only view clips for unprocessed or non-conflicted in-review alerts"
    );
  }

  const site = await getSite(alert.site_id);

  // Log access before streaming — the record exists even if the client
  // disconnects mid-stream.
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

  try {
    const client = new NxWitnessClient({
      host: site.nx_host,
      username: site.nx_username,
      password: await decryptNxPassword(site.nx_password_encrypted),
      tlsCert: site.nx_tls_cert,
    });
    const stream = await client.exportClipStream(
      alert.camera_id,
      new Date(alert.start_timestamp).getTime(),
      new Date(alert.end_timestamp).getTime()
    );
    return { stream, filename: `alert-${alertId}.mp4` };
  } catch (err) {
    if (err instanceof NxWitnessError) {
      throw new HttpError(502, `Failed to retrieve clip from Nx Witness: ${err.message}`);
    }
    // Includes credential-decrypt failures (e.g. misconfigured encryption key).
    throw new HttpError(502, "Failed to retrieve clip from Nx Witness: upstream unreachable");
  }
}

// Function URLs have no path templating, so dispatch on the raw path here:
// `/footage/history` -> archive-window flow, anything else -> alert-clip flow.
function isHistoryRequest(event) {
  const path = event.rawPath || event.requestContext?.http?.path || "";
  return /\/footage\/history\/?$/.test(path);
}

const streamHandler = async (event, responseStream) => {
  try {
    const { stream, filename } = isHistoryRequest(event)
      ? await resolveHistoryStream(event)
      : await resolveClipStream(event);
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `inline; filename="${filename}"`,
      },
    });
    await pipeline(stream, httpStream);
  } catch (err) {
    const statusCode = err instanceof HttpError ? err.statusCode : 500;
    const detail = err instanceof HttpError ? err.detail : "Internal server error";
    if (!(err instanceof HttpError)) console.error("footage stream error:", err);
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { "Content-Type": "application/json" },
    });
    httpStream.write(JSON.stringify({ detail }));
    httpStream.end();
  }
};

// `awslambda.streamifyResponse` is provided by the Lambda Node.js runtime.
export const handler = awslambda.streamifyResponse(streamHandler);
