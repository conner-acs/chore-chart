import { getPermission, listSiteIdsForUser } from "./repo/permissions.js";
import { getSite, listSitesByOrg } from "./repo/sites.js";

// Access model (SECURITY_DECISIONS Entry 014):
//   superuser  - every site, all orgs (null = no filter).
//   site_admin - every site in their OWN org, implicit (they administer the whole
//                org, mirroring their management scope in Entry 012). Never cross-org.
//   operator   - only sites with an explicit user_site_permissions row.

export async function userCanAccessSite(user, siteId) {
  if (user.role === "superuser") return true;
  if (user.role === "site_admin") {
    const site = await getSite(siteId);
    return Boolean(site) && site.organization_id === user.organization_id;
  }
  return (await getPermission(user.id, siteId)) !== null;
}

// Returns the list of site IDs the user can access, or null for superusers
// (meaning "all sites - no filter needed").
export async function getAccessibleSiteIds(user) {
  if (user.role === "superuser") return null;
  if (user.role === "site_admin") {
    const sites = await listSitesByOrg(user.organization_id);
    return sites.map((s) => s.id);
  }
  return listSiteIdsForUser(user.id);
}
