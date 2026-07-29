// Test-organisation filtering. A superadmin can flag an org as a "test org"
// (org.is_test). Each superadmin has a personal preference user.show_test_data
// (default false); when it is OFF, test-org data is hidden from their data views
// (dashboard stats, command alerts, centres, users). Management surfaces
// (/admin/organizations, /admin/sites detail) are NOT filtered so the superadmin
// can still see/manage the test orgs they created. Non-superusers are never
// affected (they only ever see their own org).

import { listOrganizations } from "./repo/organizations.js";
import { listSitesByOrg } from "./repo/sites.js";

// Should this user's data views hide test orgs? Only a superuser with the
// preference off.
export const shouldHideTestData = (user) =>
  !!user && user.role === "superuser" && !user.show_test_data;

// Set of is_test org ids from an already-loaded org list.
export const testOrgIdsFrom = (orgs) =>
  new Set((orgs || []).filter((o) => o.is_test).map((o) => o.id));

// The set of org ids to hide for this user, or null when nothing is hidden.
export async function hiddenOrgIdSet(user) {
  if (!shouldHideTestData(user)) return null;
  const ids = testOrgIdsFrom(await listOrganizations());
  return ids.size ? ids : null;
}

// The set of site ids belonging to hidden test orgs (alerts carry only site_id),
// or null when nothing is hidden.
export async function hiddenSiteIdSet(user) {
  const orgIds = await hiddenOrgIdSet(user);
  if (!orgIds) return null;
  const lists = await Promise.all([...orgIds].map((id) => listSitesByOrg(id)));
  const ids = lists.flat().map((s) => s.id);
  return ids.length ? new Set(ids) : null;
}
