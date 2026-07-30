// Response shapers — mirror the Pydantic response_models so the existing
// frontend sees identical JSON. Each picks an explicit field set and coalesces
// missing/optional values to null (DynamoDB omits undefined attributes).

import { orgSlaDays } from "./sla.js";
import { orgWorkflowConfig } from "./workflowConfig.js";

const n = (v) => (v === undefined ? null : v);

export const tokenResponse = (accessToken, refreshToken) => ({
  access_token: accessToken,
  refresh_token: refreshToken,
  token_type: "bearer",
});

export const userResponse = (u) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  phone: n(u.phone),
  role: u.role,
  organization_id: u.organization_id,
  account_created: u.account_created,
  is_active: u.is_active,
  // Per-user notification preferences (Settings toggles). Default enabled when the
  // attribute has never been set, preserving the historical always-send behaviour.
  email_notifications: u.email_notifications !== false,
  sms_notifications: u.sms_notifications !== false,
});

export const alertResponse = (a, sla = {}) => ({
  id: a.id,
  site_id: a.site_id,
  camera_id: a.camera_id,
  alert_type: a.alert_type,
  start_timestamp: a.start_timestamp,
  end_timestamp: a.end_timestamp,
  nx_bookmark_id: n(a.nx_bookmark_id),
  status: a.status,
  // Review-workflow contract (matches the frontend's mapLiveAlert).
  proposer_id: n(a.proposer_id),
  proposer_label: n(a.proposer_label),
  proposer_name: n(a.proposer_name),
  proposer_note: n(a.proposer_note),
  proposed_at: n(a.proposed_at),
  conflicted: a.conflicted ?? false,
  review_by: n(a.review_by ?? a.resolved_by),
  review_by_name: n(a.review_by_name),
  review_label: n(a.review_label),
  review_note: n(a.review_note),
  resolved_by: n(a.resolved_by),
  resolved_at: n(a.resolved_at),
  // Back-compat: decided_by stays the proposer; decision_label mirrors the
  // most relevant label (resolved label if resolved, else proposed).
  decided_by: n(a.decided_by),
  decided_at: n(a.decided_at),
  decision_label: n(a.decision_label ?? a.review_label ?? a.proposer_label),
  created_at: a.created_at,
  // Footage SLA (see lib/sla.js): deadline to action this alert + overdue flag.
  sla_deadline: sla.sla_deadline ?? null,
  overdue: sla.overdue ?? false,
  // Footage lifecycle (see lib/footageArchive.js): hot | archived | restoring | restored.
  footage_state: a.footage_state ?? "hot",
  // Structured resolution report (for reporting). Set when resolved from the
  // rich workflow form; nulls otherwise.
  resolution_category: n(a.resolution_category),
  resolution_urgency: n(a.resolution_urgency),
  resolution_urgency_severity: n(a.resolution_urgency_severity),
  resolution_notified: a.resolution_notified ?? null,
  resolution_staff: a.resolution_staff ?? null,
});

export const siteResponse = (s) => ({
  id: s.id,
  name: s.name,
  site_token: s.site_token,
  organization_id: s.organization_id,
  address: s.address ?? null,
  latitude: n(s.latitude),
  longitude: n(s.longitude),
});

export const siteUserResponse = (u) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  role: u.role,
  is_active: u.is_active,
});

export const auditLogEntryResponse = (e) => ({
  id: e.id,
  alert_id: e.alert_id,
  user_id: n(e.user_id),
  user_full_name: e.user_full_name,
  user_email: e.user_email,
  camera_id: e.camera_id,
  alert_type: e.alert_type,
  action: e.action,
  accessed_at: e.accessed_at,
});

export const organizationResponse = (o) => ({
  id: o.id,
  name: o.name,
  // Test organisation: its data is hidden from a superadmin's views unless they
  // enable "view test organisation data".
  is_test: o.is_test ?? false,
  footage_sla_days: orgSlaDays(o),
  require_restore_approval: o.require_restore_approval ?? false,
  // When true, operators may resolve alerts directly (bypass two-person review).
  allow_operator_direct_resolve: o.allow_operator_direct_resolve ?? false,
  // Incident-workflow config (effective = stored merged over defaults) so the
  // org-edit page can render + edit the current lists.
  workflow_config: orgWorkflowConfig(o),
  archived_footage_count: o.archived_footage_count ?? 0,
  // Org-level Nx Witness connection (managed on /organisations/:id). The password
  // lives only in Secrets Manager and is never returned; nx_has_password reflects
  // whether credentials have been stored (username is set alongside the password).
  nx_host: n(o.nx_host),
  nx_username: n(o.nx_username),
  nx_has_password: Boolean(o.nx_username),
  settings_modified_by: n(o.settings_modified_by),
  settings_modified_at: n(o.settings_modified_at),
});

export const restoreRequestResponse = (r) => ({
  id: r.id,
  alert_id: r.alert_id,
  // "retrieve" (restore from Glacier) | "archive" (move to Glacier).
  type: r.type ?? "retrieve",
  site_id: r.site_id,
  organization_id: r.organization_id,
  camera_id: r.camera_id,
  alert_type: r.alert_type,
  // "management_review" attention requests carry a severity + urgency label;
  // null for footage retrieve/archive requests.
  severity: n(r.severity),
  urgency: n(r.urgency),
  urgency_label: n(r.urgency_label),
  requested_by: r.requested_by,
  requested_by_label: r.requested_by_label,
  requested_at: r.requested_at,
  note: n(r.note),
  status: r.status,
  reviewed_by: n(r.reviewed_by),
  reviewed_by_label: n(r.reviewed_by_label),
  reviewed_at: n(r.reviewed_at),
  review_note: n(r.review_note),
});

export const siteSummary = (s) => ({ id: s.id, name: s.name });

export const createSiteResponse = (s, nxOk, nxDetail) => ({
  id: s.id,
  name: s.name,
  site_token: s.site_token,
  organization_id: s.organization_id,
  address: s.address ?? null,
  nx_host: s.nx_host,
  nx_username: s.nx_username,
  nx_tls_cert: n(s.nx_tls_cert),
  latitude: n(s.latitude),
  longitude: n(s.longitude),
  nx_connection_ok: nxOk,
  nx_connection_detail: nxDetail,
});

export const adminSiteListItem = (s, organizationName) => ({
  id: s.id,
  name: s.name,
  site_token: s.site_token,
  organization_id: s.organization_id,
  organization_name: organizationName,
  address: s.address ?? null,
  nx_host: s.nx_host,
  nx_username: s.nx_username,
  nx_tls_cert: n(s.nx_tls_cert),
  latitude: n(s.latitude),
  longitude: n(s.longitude),
});

export const adminUserListItem = (u, organizationName, sites) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  role: u.role,
  organization_id: u.organization_id,
  organization_name: organizationName,
  is_active: u.is_active,
  sites,
});

export const createUserResponse = (u) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  phone: n(u.phone),
  role: u.role,
  organization_id: u.organization_id,
  is_active: u.is_active,
});

// Org user row for the site-admin Users page: identity + phone + role + the
// sites this user is permitted on ([{ id, name }]).
export const orgUserListItem = (u, sites) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  phone: n(u.phone),
  role: u.role,
  is_active: u.is_active,
  sites,
});

export const updateUserResponse = (u, sites) => ({
  id: u.id,
  email: u.email,
  full_name: u.full_name,
  role: u.role,
  organization_id: u.organization_id,
  is_active: u.is_active,
  sites,
});

export const cameraResponse = (d) => ({
  id: String(d.id || d.physicalId || ""),
  name: n(d.name),
  status: n(d.status),
  model: n(d.model),
  vendor: n(d.vendor),
  mac: n(d.mac || d.physicalId),
});
