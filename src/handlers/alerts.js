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
import { alertResponse } from "../lib/presenters.js";
import { alertDecisionSchema } from "../schemas/index.js";
import { getOrganization } from "../lib/repo/organizations.js";
import { DEFAULT_SLA_DAYS, orgSlaDays, slaFields } from "../lib/sla.js";

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
  const resolveWithLabel = () => {
    alert.status = LABEL_TO_STATUS[label]; // incident | discarded
    alert.resolved_by = user.id;
    alert.review_by = user.id;
    alert.review_label = label;
    alert.review_note = note;
    alert.resolved_at = now;
    alert.decision_label = label; // mirror for back-compat
    return alert.status;
  };

  // ---- unprocessed ----
  if (alert.status === "unprocessed") {
    if (isEscalate) {
      // T1 — PROPOSE / escalate, recording the proposed label.
      alert.status = "submitted_for_review";
      alert.proposer_id = user.id;
      alert.proposer_label = label;
      alert.proposed_at = now;
      alert.conflicted = false;
      alert.decided_by = user.id; // decided_by stays the proposer
      alert.decided_at = now;
      alert.decision_label = label; // mirror for back-compat
      alert.resolved_by = null;
      alert.review_by = null;
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
    // T3 — disagreement: flag conflicted, stays in review for an admin.
    alert.conflicted = true;
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

export const handler = createRouter({
  "GET /api/v1/alerts": { fn: listAlerts, auth: "user" },
  "GET /api/v1/alerts/{alert_id}": { fn: getOneAlert, auth: "user" },
  "POST /api/v1/alerts/{alert_id}/decision": {
    fn: submitDecision,
    auth: "user",
    schema: alertDecisionSchema,
  },
});
