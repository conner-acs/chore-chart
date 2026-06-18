import { pipeline } from "stream/promises";
import { getCurrentUser } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId, nowIso } from "../lib/ids.js";
import { decryptNxPassword } from "../lib/fernet.js";
import { userCanAccessSite } from "../lib/permissions.js";
import { getAlert } from "../lib/repo/alerts.js";
import { getSite } from "../lib/repo/sites.js";
import { putFootageLog } from "../lib/repo/footageLog.js";
import { NxWitnessClient, NxWitnessError } from "../services/nxWitness.js";

// GET /footage/{alert_id} — streams the MP4 clip for an alert.
//
// Deployed as a Lambda Function URL with RESPONSE_STREAM invoke mode, NOT behind
// API Gateway: this bypasses the 10 MB / 29 s API Gateway limits and lets us pipe
// the MP4 to the client in chunks (matching the Python StreamingResponse).
// `awslambda` is a runtime global provided by the Node.js Lambda environment.
// CORS is configured on the Function URL itself (serverless.yml url.cors).

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
  if (
    user.role === "operator" &&
    (alert.status === "discarded" || alert.status === "submitted_for_review")
  ) {
    throw new HttpError(
      403,
      "Operators cannot view clips for alerts that are no longer unprocessed"
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
    return { stream, alertId };
  } catch (err) {
    if (err instanceof NxWitnessError) {
      throw new HttpError(502, `Failed to retrieve clip from Nx Witness: ${err.message}`);
    }
    // Includes credential-decrypt failures (e.g. misconfigured encryption key).
    throw new HttpError(502, "Failed to retrieve clip from Nx Witness: upstream unreachable");
  }
}

const streamHandler = async (event, responseStream) => {
  try {
    const { stream, alertId } = await resolveClipStream(event);
    const httpStream = awslambda.HttpResponseStream.from(responseStream, {
      statusCode: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": `inline; filename="alert-${alertId}.mp4"`,
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
