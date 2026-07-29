import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { getOrganization } from "../lib/repo/organizations.js";
import { getSite } from "../lib/repo/sites.js";
import { listUsersByOrg } from "../lib/repo/users.js";
import { orgWorkflowConfig } from "../lib/workflowConfig.js";

// The incident-workflow config the operator terminal renders its resolution form
// from: the alert's org config (categories / urgency / notified) plus that org's
// active staff (for the "staff involved" multi-select). Available to any
// authenticated user (operators need it to resolve alerts); GET /settings is
// site_admin-only, so this is the operator-accessible read.
//
// Scope: the org is resolved from ?site_id (the alert's site), so the form always
// reflects the org the ALERT belongs to - not the caller's own org. A non-superuser
// may only read config for a site in their OWN org; a site in another org is
// rejected with 401 (this should only ever happen for a superuser, who spans orgs).
// With no site_id, it falls back to the caller's own org.
async function getWorkflowConfig({ user, query }) {
  let orgId = user.organization_id || null;
  if (query.site_id) {
    const site = await getSite(query.site_id);
    if (!site) throw new HttpError(404, "Site not found");
    if (site.organization_id !== user.organization_id && user.role !== "superuser") {
      throw new HttpError(401, "Cannot read another organisation's workflow config");
    }
    orgId = site.organization_id;
  }

  const org = orgId ? await getOrganization(orgId) : null;
  const config = orgWorkflowConfig(org);
  const users = orgId ? await listUsersByOrg(orgId) : [];
  const staff = users
    .filter((u) => u && u.is_active !== false)
    .map((u) => ({ id: u.id, name: u.full_name || u.email }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { ...config, staff };
}

export const handler = createRouter({
  "GET /api/v1/config/workflow": { fn: getWorkflowConfig, auth: "user" },
});
