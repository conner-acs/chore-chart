import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId, nowIso } from "../lib/ids.js";
import { getAccessibleSiteIds, userCanAccessSite } from "../lib/permissions.js";
import { operatorCanSeeAlert, isAdminRole } from "../lib/alertAccess.js";
import {
  getAlert,
  listAlertsBySite,
  listAllAlerts,
  putAlert,
} from "../lib/repo/alerts.js";
import { putFootageLog } from "../lib/repo/footageLog.js";
import { listUserIdsForSite } from "../lib/repo/permissions.js";
import { getUser } from "../lib/repo/users.js";
import { getSite } from "../lib/repo/sites.js";
import { sendAlertReviewEmail } from "../services/email.js";
import { alertResponse, restoreRequestResponse } from "../lib/presenters.js";
import { alertDecisionSchema, optionalNoteSchema } from "../schemas/index.js";
import { getOrganization, decrementArchivedCount } from "../lib/repo/organizations.js";
import {
  DEFAULT_SLA_DAYS,
  orgSlaDays,
  slaFields,
  refreshedDeadlineIso,
} from "../lib/sla.js";
import {
  getRestoreRequest,
  putRestoreRequest,
  listRestoreRequestsByOrg,
} from "../lib/repo/footageRestoreRequests.js";
import { initiateRestore, isRestoreComplete } from "../lib/footageArchive.js";

const VALID_STATUSES = ["unprocessed", "discarded", "submitted_for_review", "incident"];

// Append an entry to the footage/decision audit log (denormalised for querying).
async function logAction(alert, user, action, now) {
  await putFootageLog({
    id: newId(),
    alert_id: alert.id,
    site_id: alert.site_id,
    camera_id: alert.camera_id,
    alert_type: alert.alert_type,
    user_id: user.id,
    user_email: user.email,
    user_full_name: user.full_name,
    action,
    accessed_at: now,
  });
}

// The viewing user's SLA window, resolved once and reused for all their alerts.
// Non-superusers only see their own org's alerts (org-scoped access), so the
// viewer's org is the alert's org; superusers span orgs and get the default for
// this display-only flag.
async function viewerSlaDays(user) {
  if (!user.organization_id) return DEFAULT_SLA_DAYS;
  return orgSlaDays(await getOrganization(user.organization_id));
}

async function listAlerts({ user, query }) {
  const statusFilter = query.status || null;
  const siteId = query.site_id || null;
  const limit = Math.min(parseInt(query.limit ?? "50", 10) || 50, 200);
  const offset = Math.max(parseInt(query.offset ?? "0", 10) || 0, 0);

  if (statusFilter && !VALID_STATUSES.includes(statusFilter)) {
    throw new HttpError(422, "Invalid status filter");
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

  // Operator visibility: unprocessed + non-conflicted submitted_for_review only.
  if (user.role === "operator") {
    alerts = alerts.filter(operatorCanSeeAlert);
  }
  if (statusFilter) {
    alerts = alerts.filter((a) => a.status === statusFilter);
  }

  alerts.sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // newest first

  const now = Date.now();
  const slaDays = await viewerSlaDays(user);
  return alerts
    .slice(offset, offset + limit)
    .map((a) => alertResponse(a, slaFields(a, slaDays, now)));
}

async function getOneAlert({ user, params }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (user.role === "operator" && !operatorCanSeeAlert(alert)) {
    throw new HttpError(403, "Access denied");
  }
  const slaDays = await viewerSlaDays(user);
  return alertResponse(alert, slaFields(alert, slaDays, Date.now()));
}

// Decision labels and the terminal status each derives.
const LABEL_TO_STATUS = {
  false_alarm: "discarded",
  false_positive: "discarded",
  genuine: "incident",
};

// Pure decision state machine — no I/O, so it's directly unit-testable
// (see scripts/test-decision.mjs). Mutates and returns `alert`, plus the audit
// `action` to log. Throws HttpError on a forbidden/invalid transition.
//
// The proposal/agreement unit is the LABEL (false_alarm | false_positive |
// genuine); the terminal status is derived from it (genuine→incident, else
// discarded). Only escalation is keyed on body.status === "submitted_for_review";
// every other decision is a label-keyed resolution attempt (the body's terminal
// status is ignored and re-derived from the label).
//
// Four transitions:
//   T1  unprocessed          --propose-->  submitted_for_review  (escalate w/ a proposed label)
//   T1' unprocessed          --admin----> incident | discarded   (admin resolves directly)
//   T2  submitted_for_review --resolve--> incident | discarded   (2 ops on same label, or 1 admin)
//   T3  submitted_for_review --dispute--> conflicted (flag)       (2nd op picks a different label)
// Invariants: proposer ≠ resolver; conflicted reviews are admin-only;
// decided_by stays the proposer, resolved_by/review_* records the resolver.
export function applyDecision(alert, user, body, now) {
  const isAdmin = isAdminRole(user.role);
  const isOperator = user.role === "operator";
  const label = body.decision_label; // validated to a known label by the schema
  const note = body.note ?? null;
  const isEscalate = body.status === "submitted_for_review";

  // Operators may only act on alerts they can see.
  if (isOperator && !operatorCanSeeAlert(alert)) {
    throw new HttpError(403, "Access denied");
  }

  // Apply a terminal resolution from `label`; decided_by (proposer) is preserved.
  const actorName = user.full_name || user.email || null;
  const resolveWithLabel = () => {
    alert.status = LABEL_TO_STATUS[label]; // incident | discarded
    alert.resolved_by = user.id;
    alert.review_by = user.id;
    alert.review_by_name = actorName; // denormalised so the UI shows the resolver
    alert.review_label = label;
    alert.review_note = note;
    alert.resolved_at = now;
    alert.decision_label = label; // mirror for back-compat
    return alert.status;
  };

  // ---- unprocessed ----
  if (alert.status === "unprocessed") {
    if (isEscalate) {
      // T1 — PROPOSE / escalate, recording the proposed label + the proposer's note.
      alert.status = "submitted_for_review";
      alert.proposer_id = user.id;
      alert.proposer_label = label;
      alert.proposer_name = actorName; // denormalised so the UI shows the escalator
      alert.proposer_note = note; // the escalating operator's note (was never stored)
      alert.proposed_at = now;
      alert.conflicted = false;
      alert.decided_by = user.id; // decided_by stays the proposer
      alert.decided_at = now;
      alert.decision_label = label; // mirror for back-compat
      alert.resolved_by = null;
      alert.review_by = null;
      alert.review_by_name = null;
      alert.review_label = null;
      alert.review_note = null;
      alert.resolved_at = null;
      return "submitted_for_review";
    }
    // T1' — direct resolution is admins only; operators must escalate.
    if (!isAdmin) {
      throw new HttpError(
        403,
        "Operators must escalate to review; only admins can discard or confirm directly"
      );
    }
    // Admin direct resolve: no proposer, the admin is the decider.
    alert.decided_by = user.id;
    alert.decided_at = now;
    return resolveWithLabel();
  }

  // ---- submitted_for_review ----
  if (alert.status === "submitted_for_review") {
    // proposer ≠ resolver (operators and admins alike).
    if (user.id === alert.proposer_id) {
      throw new HttpError(403, "The proposer cannot resolve their own escalation");
    }

    if (alert.conflicted) {
      // A conflicted review can only be adjudicated by an admin.
      if (!isAdmin) {
        throw new HttpError(403, "A conflicted alert can only be resolved by an administrator");
      }
      return resolveWithLabel(); // admin adjudicates
    }

    if (isAdmin) return resolveWithLabel(); // T2 — 1-admin overrules

    // Operator (different from proposer):
    if (label === alert.proposer_label) {
      return resolveWithLabel(); // T2 — 2 operators agree on the label
    }
    // T3 — disagreement: flag conflicted, stays in review for an admin. Record
    // who disagreed + the label they proposed so the conflict is attributed.
    alert.conflicted = true;
    alert.review_by = user.id;
    alert.review_by_name = actorName;
    alert.review_label = label;
    alert.review_note = note; // capture the dissent reason for the admin
    return "conflicted";
  }

  // ---- terminal (incident | discarded) ----
  throw new HttpError(409, "Alert is already resolved");
}

// Email the site's admins when an alert needs their attention — a fresh
// escalation (submitted_for_review) or a conflict raised by a second operator.
// Best-effort: failures are logged and never surfaced to the decision call.
// `kind` is "escalation" | "conflict". `actor` is the operator who acted.
async function notifySiteAdmins(alert, actor, kind) {
  const userIds = await listUserIdsForSite(alert.site_id);
  if (!userIds || userIds.length === 0) return;
  const users = await Promise.all(userIds.map((id) => getUser(id)));
  const admins = users.filter(
    (u) => u && u.role === "site_admin" && u.is_active !== false && u.email
  );
  if (admins.length === 0) return;

  const site = await getSite(alert.site_id).catch(() => null);
  const siteName = (site && site.name) || "your site";
  const actorName = actor.full_name || actor.email || "An operator";

  await Promise.all(
    admins.map((admin) =>
      sendAlertReviewEmail({
        toEmail: admin.email,
        fullName: admin.full_name,
        kind,
        alert,
        siteName,
        actorName,
      })
    )
  );
}

async function submitDecision({ user, params, body }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  const now = nowIso();
  const action = applyDecision(alert, user, body, now);
  await putAlert(alert);
  await logAction(alert, user, action, now);

  // Notify site admins on first escalation (submitted_for_review) and on a
  // conflict raised by the second operator. Awaited (Lambda freezes after the
  // response) but wrapped so a send failure never fails the decision.
  if (action === "submitted_for_review" || action === "conflicted") {
    try {
      await notifySiteAdmins(alert, user, action === "conflicted" ? "conflict" : "escalation");
    } catch (err) {
      console.warn("[alerts] site-admin notification failed:", err.message);
    }
  }

  return alertResponse(alert);
}

// Reopen a resolved alert back into review. Admins only (enforced by the route's
// site_admin auth - operators can't reopen). Reverts incident|discarded ->
// submitted_for_review: the prior decision stays on as the standing proposal label
// (so the sign-off screen shows what it had been resolved as), but the proposer
// identity is dropped so ANY admin - including the one reopening - can re-decide
// without tripping the proposer-cannot-resolve guard. All resolution fields clear.
async function reopenAlert({ user, params }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (alert.status !== "incident" && alert.status !== "discarded") {
    throw new HttpError(409, "Only a resolved alert can be reopened");
  }
  const now = nowIso();
  const priorLabel = alert.decision_label || alert.review_label || null;
  alert.status = "submitted_for_review";
  alert.proposer_id = null;
  alert.proposer_label = priorLabel;
  alert.proposer_name = null;
  alert.proposer_note = null;
  alert.proposed_at = now;
  alert.conflicted = false;
  alert.decided_by = null;
  alert.decided_at = now;
  alert.decision_label = priorLabel; // mirror for back-compat
  alert.resolved_by = null;
  alert.review_by = null;
  alert.review_by_name = null;
  alert.review_label = null;
  alert.review_note = null;
  alert.resolved_at = null;
  await putAlert(alert);
  await logAction(alert, user, "reopened", now);
  return alertResponse(alert);
}

// ---- Footage SLA: retrieve (refresh the clock) + restore-request approval ----

function buildRestoreRequest(alert, user, note, now) {
  return {
    id: newId(),
    alert_id: alert.id,
    site_id: alert.site_id,
    organization_id: alert.organization_id ?? user.organization_id,
    camera_id: alert.camera_id,
    alert_type: alert.alert_type,
    requested_by: user.id,
    requested_by_label: user.full_name || user.email,
    requested_at: now,
    note: note ?? null,
    status: "pending",
    reviewed_by: null,
    reviewed_by_label: null,
    reviewed_at: null,
    review_note: null,
  };
}

// Apply the retrieve action to an alert: restore archived footage from Glacier
// and/or refresh the SLA clock if the alert is overdue. Persists the alert.
// Returns "restoring" if a restore was kicked off, else "refreshed".
async function applyRetrieveAction(alert, slaDays, nowMs) {
  let result = "refreshed";
  if ((alert.footage_state ?? "hot") === "archived" && alert.footage_key) {
    await initiateRestore(alert.footage_key);
    alert.footage_state = "restoring";
    alert.restore_requested_at = new Date(nowMs).toISOString();
    result = "restoring";
  }
  if (slaFields(alert, slaDays, nowMs).overdue) {
    alert.sla_deadline = refreshedDeadlineIso(slaDays, nowMs);
  }
  await putAlert(alert);
  return result;
}

// Retrieve a past-due or archived alert. Self-service (restores footage /
// refreshes the SLA clock) unless the org requires approval AND the caller is a
// non-admin reviewer, in which case a pending restore request is raised for a
// site_admin to approve. Admins always retrieve directly. 409 if the alert is
// current and its footage is still hot.
async function retrieveFootage({ user, params, body }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (user.role === "operator" && !operatorCanSeeAlert(alert)) {
    throw new HttpError(403, "Access denied");
  }

  const org = user.organization_id
    ? await getOrganization(user.organization_id)
    : null;
  const slaDays = orgSlaDays(org);
  const nowMs = Date.now();
  const overdue = slaFields(alert, slaDays, nowMs).overdue;
  const archived = (alert.footage_state ?? "hot") === "archived";
  if (!overdue && !archived) {
    throw new HttpError(409, "Alert is current; nothing to retrieve");
  }

  const now = nowIso();
  const requireApproval = !!(org && org.require_restore_approval);

  // Non-admin reviewer + approval required => raise a request, don't refresh.
  if (requireApproval && !isAdminRole(user.role)) {
    const orgId = alert.organization_id ?? user.organization_id;
    const pending = (await listRestoreRequestsByOrg(orgId)).find(
      (r) => r.alert_id === alert.id && r.status === "pending"
    );
    if (pending) {
      return {
        result: "already_pending",
        request: restoreRequestResponse(pending),
        alert: alertResponse(alert, slaFields(alert, slaDays, nowMs)),
      };
    }
    const req = buildRestoreRequest(alert, user, body?.note, now);
    await putRestoreRequest(req);
    await logAction(alert, user, "restore_requested", now);
    return {
      result: "pending_approval",
      request: restoreRequestResponse(req),
      alert: alertResponse(alert, slaFields(alert, slaDays, nowMs)),
    };
  }

  // Self-service: restore archived footage and/or refresh the SLA clock.
  const result = await applyRetrieveAction(alert, slaDays, nowMs);
  await logAction(
    alert,
    user,
    result === "restoring" ? "restore_initiated" : "retrieve",
    now
  );
  return {
    result,
    request: null,
    alert: alertResponse(alert, slaFields(alert, slaDays, Date.now())),
  };
}

// Site-admin: the org's restore requests (newest first) for the Requests queue.
async function listRestoreRequests({ user, query }) {
  if (!user.organization_id) return [];
  let requests = await listRestoreRequestsByOrg(user.organization_id);
  if (query.status) {
    requests = requests.filter((r) => r.status === query.status);
  }
  return requests.map(restoreRequestResponse);
}

// Approve or deny a pending restore request. Approval refreshes the alert's SLA
// clock so it can be actioned again; both outcomes record the reviewer + note.
async function reviewRestore(user, requestId, approved, note) {
  const req = await getRestoreRequest(requestId);
  if (!req) throw new HttpError(404, "Restore request not found");
  if (user.role !== "superuser" && req.organization_id !== user.organization_id) {
    throw new HttpError(403, "Access denied");
  }
  if (req.status !== "pending") {
    throw new HttpError(409, `Request already ${req.status}`);
  }

  const now = nowIso();
  req.status = approved ? "approved" : "denied";
  req.reviewed_by = user.id;
  req.reviewed_by_label = user.full_name || user.email;
  req.reviewed_at = now;
  req.review_note = note ?? null;
  await putRestoreRequest(req);

  const alert = await getAlert(req.alert_id);
  let alertOut = null;
  if (alert) {
    const slaDays = orgSlaDays(await getOrganization(req.organization_id));
    if (approved) {
      await applyRetrieveAction(alert, slaDays, Date.now());
    }
    await logAction(alert, user, approved ? "restore_approved" : "restore_denied", now);
    alertOut = alertResponse(alert, slaFields(alert, slaDays, Date.now()));
  }
  return { request: restoreRequestResponse(req), alert: alertOut };
}

async function approveRestore({ user, params, body }) {
  return reviewRestore(user, params.request_id, true, body?.note);
}

async function denyRestore({ user, params, body }) {
  return reviewRestore(user, params.request_id, false, body?.note);
}

// Poll an alert's footage state; if a Glacier restore has finished, flip
// restoring -> restored and decrement the org's archived counter.
async function checkFootageStatus({ user, params }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (user.role === "operator" && !operatorCanSeeAlert(alert)) {
    throw new HttpError(403, "Access denied");
  }
  let state = alert.footage_state ?? "hot";
  if (
    state === "restoring" &&
    alert.footage_key &&
    (await isRestoreComplete(alert.footage_key))
  ) {
    alert.footage_state = "restored";
    alert.restored_at = nowIso();
    await putAlert(alert);
    const site = await getSite(alert.site_id);
    if (site) await decrementArchivedCount(site.organization_id);
    state = "restored";
  }
  return {
    alert_id: alert.id,
    footage_state: state,
    archived_at: alert.archived_at ?? null,
    restored_at: alert.restored_at ?? null,
  };
}

export const handler = createRouter({
  "GET /api/v1/alerts": { fn: listAlerts, auth: "user" },
  "GET /api/v1/alerts/{alert_id}": { fn: getOneAlert, auth: "user" },
  "POST /api/v1/alerts/{alert_id}/decision": {
    fn: submitDecision,
    auth: "user",
    schema: alertDecisionSchema,
  },
  "POST /api/v1/alerts/{alert_id}/reopen": {
    fn: reopenAlert,
    auth: "site_admin", // admins only; operators can't reopen a resolved alert
  },
  "POST /api/v1/alerts/{alert_id}/retrieve": {
    fn: retrieveFootage,
    auth: "user",
    schema: optionalNoteSchema,
  },
  "GET /api/v1/alerts/{alert_id}/footage-status": {
    fn: checkFootageStatus,
    auth: "user",
  },
  "GET /api/v1/restore-requests": {
    fn: listRestoreRequests,
    auth: "site_admin",
  },
  "POST /api/v1/restore-requests/{request_id}/approve": {
    fn: approveRestore,
    auth: "site_admin",
    schema: optionalNoteSchema,
  },
  "POST /api/v1/restore-requests/{request_id}/deny": {
    fn: denyRestore,
    auth: "site_admin",
    schema: optionalNoteSchema,
  },
});
