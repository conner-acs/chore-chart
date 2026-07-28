import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { getOrganization, putOrganization } from "../lib/repo/organizations.js";
import { organizationResponse } from "../lib/presenters.js";
import { orgSettingsSchema } from "../schemas/index.js";
import { applyFootagePolicy, notifyOrgSettingsChanged } from "../lib/orgNotify.js";

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
  // Apply the new policy (records who/when), then persist. On a real change, email
  // every site_admin of the org what changed + who changed it (best-effort).
  const changes = applyFootagePolicy(org, body, user);
  await putOrganization(org);
  await notifyOrgSettingsChanged({ org, changes, actor: user });
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
