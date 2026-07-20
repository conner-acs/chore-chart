// Footage SLA: every open alert must be actioned within the org's SLA window.
// Past the deadline the alert is "overdue" and its footage becomes eligible for
// archival; a reviewer can later "retrieve" it, which refreshes the deadline so
// it can be actioned again (see the retrieve flow).
//
// The window is a per-org policy (footage_sla_days) that a site_admin can adjust
// between 1 and 14 days, defaulting to 7. The effective deadline is derived from
// the alert's created_at unless an explicit sla_deadline override is stored -
// the retrieve flow writes that override to restart the clock.

export const DAY_MS = 86_400_000;
export const DEFAULT_SLA_DAYS = 7;
export const MIN_SLA_DAYS = 1;
export const MAX_SLA_DAYS = 14;

// Non-terminal statuses: still awaiting a final decision, so the SLA clock runs.
// (incident / discarded are terminal - the alert has been actioned.)
export const OPEN_STATUSES = ["unprocessed", "submitted_for_review"];

// Resolve an org's configured SLA window, clamped to the allowed range, with a
// safe default when the field is unset or malformed.
export const orgSlaDays = (org) => {
  const days = Number(org?.footage_sla_days);
  return Number.isInteger(days) && days >= MIN_SLA_DAYS && days <= MAX_SLA_DAYS
    ? days
    : DEFAULT_SLA_DAYS;
};

// Effective deadline (ms): an explicit override wins (retrieve restarts the
// clock); otherwise it is created_at + the SLA window.
export const slaDeadlineMs = (alert, slaDays) =>
  alert.sla_deadline
    ? Date.parse(alert.sla_deadline)
    : Date.parse(alert.created_at) + slaDays * DAY_MS;

// The SLA fields surfaced on an alert response: the ISO deadline and whether an
// open alert has passed it.
export const slaFields = (alert, slaDays, nowMs) => {
  const deadlineMs = slaDeadlineMs(alert, slaDays);
  return {
    sla_deadline: new Date(deadlineMs).toISOString(),
    overdue: OPEN_STATUSES.includes(alert.status) && nowMs > deadlineMs,
  };
};
