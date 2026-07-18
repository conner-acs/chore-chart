import { getPermission, listSiteIdsForUser } from "./repo/permissions.js";
import { getSite, listSitesByOrg } from "./repo/sites.js";

// Superusers have implicit access to every site. Operators and site_admins must
// have an explicit user_site_permissions row AND the site must belong to their
// own organization. The org check is defence in depth: a stray cross-org
// permission row (e.g. bad seed/import data) must never leak another org's
// alerts or footage. Mirrors app/core/permissions.py.

export async function userCanAccessSite(user, siteId) {
  if (user.role === "superuser") return true;
  if ((await getPermission(user.id, siteId)) === null) return false;
  const site = await getSite(siteId);
  return !!site && site.organization_id === user.organization_id;
}

// Returns the list of site IDs the user can access, or null for superusers
// (meaning "all sites - no filter needed"). For everyone else this is the
// intersection of their permissioned sites and their own organization's sites,
// so a cross-org permission row is ignored rather than leaking another org.
export async function getAccessibleSiteIds(user) {
  if (user.role === "superuser") return null;
  const [permitted, orgSites] = await Promise.all([
    listSiteIdsForUser(user.id),
    listSitesByOrg(user.organization_id),
  ]);
  const inOrg = new Set(orgSites.map((s) => s.id));
  return permitted.filter((id) => inOrg.has(id));
}
