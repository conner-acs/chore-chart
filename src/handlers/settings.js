import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { getOrganization, putOrganization } from "../lib/repo/organizations.js";
import { organizationResponse } from "../lib/presenters.js";
import { orgSettingsSchema } from "../schemas/index.js";

// Per-org footage policy, readable/editable by a site_admin for their OWN org.
// The org is always resolved from the caller's token (user.organization_id),
// never from a path or body param, so a site_admin can never reach another org.
async function callerOrg(user) {
  if (!user.organization_id) {
    throw new HttpError(400, "No organization for this account");
  }
  const org = await getOrganization(user.organization_id);
  if (!org) throw new HttpError(404, "Organization not found");
  return org;
}

async function getSettings({ user }) {
  return organizationResponse(await callerOrg(user));
}

async function updateSettings({ user, body }) {
  const org = await callerOrg(user);
  if (body.footage_sla_days !== undefined) {
    org.footage_sla_days = body.footage_sla_days;
  }
  if (body.require_restore_approval !== undefined) {
    org.require_restore_approval = body.require_restore_approval;
  }
  await putOrganization(org);
  return organizationResponse(org);
}

export const handler = createRouter({
  "GET /api/v1/settings": { fn: getSettings, auth: "site_admin" },
  "PATCH /api/v1/settings": {
    fn: updateSettings,
    auth: "site_admin",
    schema: orgSettingsSchema,
  },
});
