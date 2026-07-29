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
import {
  getOrganization,
  incrementArchivedCount,
  decrementArchivedCount,
} from "../lib/repo/organizations.js";
import { DEFAULT_SLA_DAYS, orgSlaDays, slaFields } from "../lib/sla.js";
import {
  getRestoreRequest,
  putRestoreRequest,
  listRestoreRequestsByOrg,
} from "../lib/repo/footageRestoreRequests.js";
import {
  initiateRestore,
  isRestoreComplete,
  archivePlaceholder,
  footageKey,
} from "../lib/footageArchive.js";
import { urgencySeverity, urgencyLabel } from "../lib/workflowConfig.js";
import { hiddenSiteIdSet } from "../lib/testOrgs.js";

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

  // Superadmin with test-org data hidden: drop alerts in test-org sites (null for
  // every other user, so this is a no-op except for a superuser with the pref off).
  const hiddenSites = await hiddenSiteIdSet(user);
  if (hiddenSites) alerts = alerts.filter((a) => !hiddenSites.has(a.site_id));

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
export function applyDecision(alert, user, body, now, { allowOperatorDirectResolve = false } = {}) {
  const isAdmin = isAdminRole(user.role);
  const isOperator = user.role === "operator";
  // Org policy: when enabled, operators may resolve directly (bypass two-person
  // review) - their single decision is final, like an admin's.
  const canResolveDirectly = isAdmin || allowOperatorDirectResolve;
  const label = body.decision_label; // validated to a known label by the schema
  const note = body.note ?? null;
  const isEscalate = body.status === "submitted_for_review";

  // Operators may only act on alerts they can see.
  if (isOperator && !operatorCanSeeAlert(alert)) {
    throw new HttpError(403, "Access denied");
  }

  // Capture the structured resolution report (from the org's workflow form) onto
  // the alert for reporting. Only fields PRESENT in the body are written, so a
  // second reviewer's plain confirm never wipes the proposer's report. The
  // urgency severity is denormalised by the caller (submitDecision has the org).
  if (body.resolution_category !== undefined) {
    alert.resolution_category = body.resolution_category || null;
  }
  if (body.resolution_urgency !== undefined) {
    alert.resolution_urgency = body.resolution_urgency || null;
  }
  if (body.resolution_notified !== undefined) {
    alert.resolution_notified = body.resolution_notified || null;
  }
  if (body.resolution_staff !== undefined) {
    alert.resolution_staff = body.resolution_staff || null;
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
    // T1' — direct resolution: admins always; operators only when the org allows
    // it (allow_operator_direct_resolve). Otherwise operators must escalate.
    if (!canResolveDirectly) {
      throw new HttpError(
        403,
        "Operators must escalate to review; only admins can discard or confirm directly"
      );
    }
    // Direct resolve: no proposer, the decider is the (admin or operator) actor.
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
  const orgId = alert.organization_id ?? user.organization_id;
  const org = orgId ? await getOrganization(orgId) : null;
  // Operators can resolve directly only if their org opts in; admins always can.
  const allowOperatorDirectResolve =
    user.role === "operator" && !!(org && org.allow_operator_direct_resolve);

  const action = applyDecision(alert, user, body, now, { allowOperatorDirectResolve });

  // Denormalise the urgency severity from the org config (for reporting + the
  // attention-request routing below).
  let severity = "normal";
  if (body.decision_label === "genuine" && body.resolution_urgency) {
    severity = urgencySeverity(org, body.resolution_urgency);
    alert.resolution_urgency_severity = severity;
  }

  await putAlert(alert);
  await logAction(alert, user, action, now);

  // A genuine incident with a non-normal urgency raises an admin-attention request
  // (critical -> pinned notification + dashboard banner; management -> normal
  // Requests-tab item). Deduped to one pending request per alert so the two-person
  // flow (escalate then confirm) doesn't double-raise it.
  if (severity === "critical" || severity === "management") {
    try {
      const existing = (await listRestoreRequestsByOrg(orgId)).find(
        (r) =>
          r.alert_id === alert.id && r.type === "management_review" && r.status === "pending"
      );
      if (!existing) {
        await putRestoreRequest(buildAttentionRequest(alert, user, severity, body, now, org));
        await logAction(alert, user, "management_requested", now);
      }
    } catch (err) {
      console.warn("[alerts] attention request failed:", err.message);
    }
  }

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
  // Clear the structured resolution report too, so a reopened alert doesn't carry
  // stale genuine/critical metadata into a different re-resolution.
  alert.resolution_category = null;
  alert.resolution_urgency = null;
  alert.resolution_urgency_severity = null;
  alert.resolution_notified = null;
  alert.resolution_staff = null;
  await putAlert(alert);
  await logAction(alert, user, "reopened", now);
  return alertResponse(alert);
}

// ---- Footage SLA: retrieve (refresh the clock) + restore-request approval ----

// type: "retrieve" (restore from Glacier) | "archive" (move to Glacier). The
// same request queue serves both - only a site_admin approves/executes them.
function buildRestoreRequest(alert, user, note, now, type = "retrieve") {
  return {
    id: newId(),
    alert_id: alert.id,
    type,
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

// A management/critical attention request for a genuine incident. Reuses the same
// request queue (type "management_review") so it surfaces in the site-admin
// Requests tab + bell. `severity` is "critical" | "management" (from the org's
// urgency config); the frontend pins + red-banners the critical ones.
function buildAttentionRequest(alert, user, severity, body, now, org) {
  return {
    id: newId(),
    alert_id: alert.id,
    type: "management_review",
    severity,
    urgency: body.resolution_urgency || null,
    urgency_label: urgencyLabel(org, body.resolution_urgency),
    site_id: alert.site_id,
    organization_id: alert.organization_id ?? user.organization_id,
    camera_id: alert.camera_id,
    alert_type: alert.alert_type,
    requested_by: user.id,
    requested_by_label: user.full_name || user.email,
    requested_at: now,
    note: body.note ?? null,
    status: "pending",
    reviewed_by: null,
    reviewed_by_label: null,
    reviewed_at: null,
    review_note: null,
  };
}

// Restore an ARCHIVED alert's footage from Glacier (archived -> restoring).
async function applyRestoreAction(alert, nowMs) {
  const key = alert.footage_key || footageKey(alert);
  await initiateRestore(key);
  alert.footage_state = "restoring";
  alert.footage_key = key;
  alert.restore_requested_at = new Date(nowMs).toISOString();
  await putAlert(alert);
  return "restoring";
}

// Move a HOT alert's footage to Glacier cold storage (hot -> archived) and bump
// the org's archived counter.
async function applyArchiveAction(alert, orgId, nowMs) {
  const key = await archivePlaceholder(alert);
  alert.footage_state = "archived";
  alert.footage_key = key;
  alert.archived_at = new Date(nowMs).toISOString();
  await putAlert(alert);
  if (orgId) await incrementArchivedCount(orgId, 1);
  return "archived";
}

// Find a pending request of `type` for this alert, if any.
async function pendingFootageRequest(orgId, alertId, type) {
  return (await listRestoreRequestsByOrg(orgId)).find(
    (r) => r.alert_id === alertId && (r.type ?? "retrieve") === type && r.status === "pending"
  );
}

// Retrieve (restore from Glacier) an ARCHIVED alert. Only a site_admin may run the
// Glacier restore; anyone else raises a pending request for a site_admin to
// approve. 409 if the footage isn't archived.
async function retrieveFootage({ user, params, body }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (user.role === "operator" && !operatorCanSeeAlert(alert)) {
    throw new HttpError(403, "Access denied");
  }
  if ((alert.footage_state ?? "hot") !== "archived") {
    throw new HttpError(409, "Footage is not archived; nothing to retrieve");
  }

  const org = user.organization_id ? await getOrganization(user.organization_id) : null;
  const slaDays = orgSlaDays(org);
  const nowMs = Date.now();
  const now = nowIso();
  const orgId = alert.organization_id ?? user.organization_id;
  const sla = () => slaFields(alert, slaDays, Date.now());

  // Only site_admins may pull footage back from Glacier; everyone else requests it.
  if (!isAdminRole(user.role)) {
    const pending = await pendingFootageRequest(orgId, alert.id, "retrieve");
    if (pending) {
      return { result: "already_pending", request: restoreRequestResponse(pending), alert: alertResponse(alert, sla()) };
    }
    const req = buildRestoreRequest(alert, user, body?.note, now, "retrieve");
    await putRestoreRequest(req);
    await logAction(alert, user, "restore_requested", now);
    return { result: "pending_approval", request: restoreRequestResponse(req), alert: alertResponse(alert, sla()) };
  }

  const result = await applyRestoreAction(alert, nowMs);
  await logAction(alert, user, "restore_initiated", now);
  return { result, request: null, alert: alertResponse(alert, sla()) };
}

// Archive (move to Glacier) a HOT alert whose retention window (SLA) has lapsed.
// Only a site_admin runs the Glacier move; anyone else raises a pending request.
// 409 if the footage isn't hot, or is still within its retention window.
async function archiveFootage({ user, params, body }) {
  const alert = await getAlert(params.alert_id);
  if (!alert) throw new HttpError(404, "Alert not found");
  if (!(await userCanAccessSite(user, alert.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (user.role === "operator" && !operatorCanSeeAlert(alert)) {
    throw new HttpError(403, "Access denied");
  }
  if ((alert.footage_state ?? "hot") !== "hot") {
    throw new HttpError(409, "Footage is not hot; nothing to archive");
  }

  const org = user.organization_id ? await getOrganization(user.organization_id) : null;
  const slaDays = orgSlaDays(org);
  const nowMs = Date.now();
  const now = nowIso();
  const orgId = alert.organization_id ?? user.organization_id;
  const sla = () => slaFields(alert, slaDays, Date.now());
  // A RESOLVED alert (incident|discarded) can be archived on demand - operators
  // can't see resolved alerts, so this path is site_admin/superuser only. Any
  // other alert must be past its retention window (the auto-archival threshold).
  const isResolved = alert.status === "incident" || alert.status === "discarded";
  if (!isResolved && !slaFields(alert, slaDays, nowMs).overdue) {
    throw new HttpError(409, "Footage is within its retention window; not yet due for archival");
  }

  // Only site_admins may move footage to Glacier; everyone else requests it.
  if (!isAdminRole(user.role)) {
    const pending = await pendingFootageRequest(orgId, alert.id, "archive");
    if (pending) {
      return { result: "already_pending", request: restoreRequestResponse(pending), alert: alertResponse(alert, sla()) };
    }
    const req = buildRestoreRequest(alert, user, body?.note, now, "archive");
    await putRestoreRequest(req);
    await logAction(alert, user, "archive_requested", now);
    return { result: "pending_approval", request: restoreRequestResponse(req), alert: alertResponse(alert, sla()) };
  }

  const result = await applyArchiveAction(alert, orgId, nowMs);
  await logAction(alert, user, "archived", now);
  return { result, request: null, alert: alertResponse(alert, sla()) };
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
    const type = req.type ?? "retrieve";
    if (approved) {
      if (type === "archive") await applyArchiveAction(alert, req.organization_id, Date.now());
      else if (type === "retrieve") await applyRestoreAction(alert, Date.now());
      // "management_review" has no footage side-effect - actioning it just flips
      // the request status (clearing it from the queue/banner/pins).
    }
    const verb =
      type === "management_review" ? "management" : type === "archive" ? "archive" : "restore";
    await logAction(alert, user, `${verb}_${approved ? "approved" : "denied"}`, now);
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
    auth: "user", // any user may ask; non-admins raise a request, admins execute
    schema: optionalNoteSchema,
  },
  "POST /api/v1/alerts/{alert_id}/archive": {
    fn: archiveFootage,
    auth: "user", // any user may ask; non-admins raise a request, admins execute
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
