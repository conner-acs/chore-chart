// Per-org incident-workflow configuration: the dynamic lists an operator picks
// from when resolving an alert. Superadmins edit these on /organisations/:id.
//
// - categories.false_alarm / .false_positive: reason checkboxes for a false call.
// - urgency: levels for a GENUINE incident. Each has a `severity` that routes the
//     admin-attention request (see lib/alertRequests semantics):
//       "critical"  -> pinned notification + dashboard red banner (immediate).
//       "management"-> normal management-review request in the Requests tab.
//       "normal"    -> no admin-attention request raised.
// - notified: "who has been notified" checkboxes for a genuine incident.
// - alert_types: the detection (alert) types the org's cameras raise. Drives the
//     Resolved-tab "Alert Type" filter in the operator portal. Each { id, label }
//     id matches the alert record's `type` (e.g. CHILD_ALONE).
//
// An org with no stored workflow_config falls back to these defaults, so existing
// orgs work unchanged.

export const SEVERITIES = ["critical", "management", "normal"];

export const DEFAULT_WORKFLOW_CONFIG = {
  alert_types: [
    { id: "CHILD_ALONE", label: "Child Alone" },
    { id: "CHILD_IN_NO_GO_ZONE", label: "No-Go Zone" },
    { id: "BLACKLISTED_VEHICLE", label: "Blacklisted Vehicle" },
    { id: "CHILD_ALONE_WITH_ADULT", label: "Adult Alone with Child" },
  ],
  categories: {
    false_alarm: [
      { id: "poster", label: "Poster or wall art" },
      { id: "object", label: "Object in the room" },
      { id: "shadow", label: "Shadow / lighting change" },
      { id: "animal", label: "Animal or pet" },
      { id: "reflection", label: "Reflection / glare" },
      { id: "other", label: "Other" },
    ],
    false_positive: [
      { id: "staff-as-child", label: "Staff member identified as child" },
      { id: "child-as-adult", label: "Older child identified as adult" },
      { id: "visitor", label: "Visitor / parent misidentified" },
      { id: "plate", label: "Vehicle plate misread" },
      { id: "other", label: "Other" },
    ],
  },
  urgency: [
    {
      id: "immediate",
      label: "Immediate interference required",
      hint: "Dispatch police / contact parent / on-site response",
      severity: "critical",
    },
    {
      id: "deferred",
      label: "Raise to management for processing",
      hint: "Document and queue for next-business-day review",
      severity: "management",
    },
  ],
  notified: [
    { id: "site-manager", label: "Site manager" },
    { id: "centre-director", label: "Centre director" },
    { id: "parent", label: "Parent / guardian" },
    { id: "police", label: "Police" },
    { id: "management", label: "SafeDay Management" },
  ],
};

const list = (v, fallback) => (Array.isArray(v) && v.length ? v : fallback);

// The effective config for an org (stored values merged over the defaults). Never
// returns empty lists (an org that clears a list falls back to the default).
export function orgWorkflowConfig(org) {
  const c = (org && org.workflow_config) || {};
  const cats = c.categories || {};
  return {
    alert_types: list(c.alert_types, DEFAULT_WORKFLOW_CONFIG.alert_types),
    categories: {
      false_alarm: list(cats.false_alarm, DEFAULT_WORKFLOW_CONFIG.categories.false_alarm),
      false_positive: list(cats.false_positive, DEFAULT_WORKFLOW_CONFIG.categories.false_positive),
    },
    urgency: list(c.urgency, DEFAULT_WORKFLOW_CONFIG.urgency),
    notified: list(c.notified, DEFAULT_WORKFLOW_CONFIG.notified),
  };
}

// Severity of a chosen urgency id for an org ("critical" | "management" | "normal").
export function urgencySeverity(org, urgencyId) {
  if (!urgencyId) return "normal";
  const u = orgWorkflowConfig(org).urgency.find((x) => x.id === urgencyId);
  return (u && u.severity) || "normal";
}

// Label lookups so denormalised report data is human-readable.
export function urgencyLabel(org, urgencyId) {
  const u = orgWorkflowConfig(org).urgency.find((x) => x.id === urgencyId);
  return (u && u.label) || urgencyId || null;
}

export function notifiedLabels(org, ids) {
  const map = new Map(orgWorkflowConfig(org).notified.map((n) => [n.id, n.label]));
  return (ids || []).map((id) => map.get(id) || id);
}
