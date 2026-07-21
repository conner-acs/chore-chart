import { getPermission, listSiteIdsForUser } from "./repo/permissions.js";

// Superusers have implicit access to every site. Operators and site_admins
// must have an explicit user_site_permissions row. Mirrors app/core/permissions.py.

export async function userCanAccessSite(user, siteId) {
  if (user.role === "superuser") return true;
  return (await getPermission(user.id, siteId)) !== null;
}

// Returns the list of site IDs the user can access, or null for superusers
// (meaning "all sites — no filter needed").
export async function getAccessibleSiteIds(user) {
  if (user.role === "superuser") return null;
  return listSiteIdsForUser(user.id);
}
