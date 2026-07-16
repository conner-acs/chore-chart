// Operator visibility/action rule for alerts, shared by the alerts and footage
// handlers. Operators may see and act on:
//   - unprocessed alerts, and
//   - submitted_for_review alerts that are NOT conflicted.
// They never see incident, discarded, or conflicted (admin-adjudicated) reviews.
export const operatorCanSeeAlert = (alert) =>
  alert.status === "unprocessed" ||
  (alert.status === "submitted_for_review" && !alert.conflicted);

export const isAdminRole = (role) => role === "site_admin" || role === "superuser";
