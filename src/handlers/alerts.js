import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId, nowIso } from "../lib/ids.js";
import { getAccessibleSiteIds, userCanAccessSite } from "../lib/permissions.js";
import {
  getAlert,
  listAlertsBySite,
  listAllAlerts,
  putAlert,
} from "../lib/repo/alerts.js";
import { putFootageLog } from "../lib/repo/footageLog.js";
import { alertResponse } from "../lib/presenters.js";
import { alertDecisionSchema } from "../schemas/index.js";

const VALID_STATUSES = ["unprocessed", "discarded", "submitted_for_review", "incident"];

async function listAlerts({ user, query }) {
  const statusFilter = query.status || null;
  const siteId = query.site_id || null;
  const limit = Math.min(parseInt(query.limit ?? "50", 10) || 50, 200);
  const offset = Math.max(parseInt(query.offset ?? "0", 10) || 0, 0);

  if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
    throw new HttpError(422, "Invalid status filter");
  }
  // Operators cannot see the submitted_for_review queue.
  if (statusFilter === "submitted_for_review" && user.role === "operator") {
    throw new HttpError(403, "Access denied");
  }

  const accessible = await getAccessibleSiteIds(user); // null = superuser (all)

  let alerts;
  if (siteId) {
    if (accessible !== null && !accessible.includes(siteId)) {
      throw new HttpError(403, "Access denied");
    }
    alerts = await listAlertsBySite(siteId);
  } else if (accessible === null) {
    alerts = await listAllAlerts();
  } else {
    const lists = await Promise.all(accessible.map((s) => listAlertsBySite(s)));
    alerts = lists.flat();
  }

  // Operators never see submitted_for_review, filtered or not.
  if (user.role === "operator") {
    alerts = alerts.filter((a) => a.status !== "submitted_for_review");
  }
  if (statusFilter) {
    alerts = alerts.filter((a) => a.status === statusFilter);
  }

  alerts.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first
  return alerts.slice(offset, offset + limit).map(alertResponse);
}

async function getOneAlert({ user, params }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  return alertResponse(alert);
}

async function submitDecision({ user, params, body }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }

  const isAdmin = user.role === "site_admin" || user.role === "superuser";
  const resolvingReview =
    alert.status === "submitted_for_review" &&
    (body.status === "discarded" || body.status === "incident") &&
    isAdmin;

  if (!(alert.status === "unprocessed" || resolvingReview)) {
    throw new HttpError(409, "Alert cannot be transitioned to the requested status");
  }

  const now = nowIso();
  alert.status = body.status;
  alert.decided_by = user.id;
  alert.decided_at = now;
  alert.decision_label = body.decision_label ?? null;
  await putAlert(alert);

  // Action mirrors the decision (clip_viewed is logged by the footage route).
  await putFootageLog({
    id: newId(),
    alert_id: alert.id,
    site_id: alert.site_id, // denormalised for the audit-log query
    camera_id: alert.camera_id, // denormalised for the audit-log response
    alert_type: alert.alert_type,
    user_id: user.id,
    user_email: user.email,
    user_full_name: user.full_name,
    action: body.status,
    accessed_at: now,
  });

  return alertResponse(alert);
}

export const handler = createRouter({
  "GET /api/v1/alerts": { fn: listAlerts, auth: "user" },
  "GET /api/v1/alerts/{alert_id}": { fn: getOneAlert, auth: "user" },
  "POST /api/v1/alerts/{alert_id}/decision": {
    fn: submitDecision,
    auth: "user",
    schema: alertDecisionSchema,
  },
});
