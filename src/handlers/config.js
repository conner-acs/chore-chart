import { createRouter } from "../lib/middleware.js";
import { getOrganization } from "../lib/repo/organizations.js";
import { listUsersByOrg } from "../lib/repo/users.js";
import { orgWorkflowConfig } from "../lib/workflowConfig.js";

// The incident-workflow config the operator terminal renders its resolution form
// from: the caller's org config (categories / urgency / notified) plus the org's
// active staff (for the "staff involved" multi-select). Available to any
// authenticated user (operators need it to resolve alerts); GET /settings is
// site_admin-only, so this is the operator-accessible read.
async function getWorkflowConfig({ user }) {
  const org = user.organization_id ? await getOrganization(user.organization_id) : null;
  const config = orgWorkflowConfig(org);
  const users = user.organization_id ? await listUsersByOrg(user.organization_id) : [];
  const staff = users
    .filter((u) => u && u.is_active !== false)
    .map((u) => ({ id: u.id, name: u.full_name || u.email }))
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return { ...config, staff };
}

export const handler = createRouter({
  "GET /api/v1/config/workflow": { fn: getWorkflowConfig, auth: "user" },
});
