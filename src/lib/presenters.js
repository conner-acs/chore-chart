// Response shapers — mirror the Pydantic response_models so the existing
// frontend sees identical JSON. Each picks an explicit field set and coalesces
// missing/optional values to null (DynamoDB omits undefined attributes).

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
  role: u.role,
  organization_id: u.organization_id,
  account_created: u.account_created,
  is_active: u.is_active,
});

export const alertResponse = (a) => ({
  id: a.id,
  site_id: a.site_id,
  camera_id: a.camera_id,
  alert_type: a.alert_type,
  start_timestamp: a.start_timestamp,
  end_timestamp: a.end_timestamp,
  nx_bookmark_id: n(a.nx_bookmark_id),
  status: a.status,
  decided_by: n(a.decided_by),
  decided_at: n(a.decided_at),
  decision_label: n(a.decision_label),
  created_at: a.created_at,
});

export const siteResponse = (s) => ({
  id: s.id,
  name: s.name,
  site_token: s.site_token,
  organization_id: s.organization_id,
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

export const organizationResponse = (o) => ({ id: o.id, name: o.name });

export const siteSummary = (s) => ({ id: s.id, name: s.name });

export const createSiteResponse = (s, nxOk, nxDetail) => ({
  id: s.id,
  name: s.name,
  site_token: s.site_token,
  organization_id: s.organization_id,
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
  role: u.role,
  organization_id: u.organization_id,
  is_active: u.is_active,
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
