import { createRouter, ROLE_RANK } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId } from "../lib/ids.js";
import { getSecret, getOrgNxCredentials } from "../lib/secrets.js";
import { receiveAlert } from "./webhooks.js";
import { sweep } from "./archiver.js";
import { userCanAccessSite, getAccessibleSiteIds } from "../lib/permissions.js";
import { hashPassword, createSetPasswordToken } from "../lib/auth.js";
import { encryptNxPassword, decryptNxPassword } from "../lib/fernet.js";
import { NxWitnessClient, NxWitnessError } from "../services/nxWitness.js";
import { sendSetPasswordEmail, sendTestEmail } from "../services/email.js";
import {
  listOrganizations,
  listOrganizationsPage,
  countOrganizations,
  getOrganization,
  putOrganization,
  deleteOrganization,
} from "../lib/repo/organizations.js";
import {
  getSite,
  getSiteByToken,
  listSitesByOrg,
  listSitesByOrgPage,
  listAllSites,
  listAllSitesPage,
  countSites,
  putSite,
  deleteSite,
} from "../lib/repo/sites.js";
import {
  getUser,
  getUserByEmail,
  listAllUsers,
  listAllUsersPage,
  listUsersByOrg,
  listUsersByOrgPage,
  countUsers,
  putUser,
  deleteUser,
} from "../lib/repo/users.js";
import { pageLimit } from "../lib/pagination.js";
import { applyFootagePolicy, notifyOrgSettingsChanged } from "../lib/orgNotify.js";
import {
  putPermission,
  listSiteIdsForUser,
  deleteAllForUser,
  deleteAllForSite,
} from "../lib/repo/permissions.js";
import { hasAlertsForSite } from "../lib/repo/alerts.js";
import { deleteAllForUser as deleteTokensForUser } from "../lib/repo/deviceTokens.js";
import {
  organizationResponse,
  createSiteResponse,
  adminSiteListItem,
  adminUserListItem,
  createUserResponse,
  updateUserResponse,
  orgUserListItem,
  siteSummary,
  cameraResponse,
} from "../lib/presenters.js";
import {
  createOrganizationSchema,
  adminOrgUpdateSchema,
  createSiteSchema,
  createSiteInOrgSchema,
  createUserSchema,
  updateUserSchema,
  orgUserCreateSchema,
  orgUserUpdateSchema,
  testAlertSchema,
  preferencesSchema,
} from "../schemas/index.js";
import { shouldHideTestData, testOrgIdsFrom } from "../lib/testOrgs.js";

const today = () => new Date().toISOString().slice(0, 10);

// Try to authenticate to a site's Nx server. Never throws — returns [ok, detail].
// Also exercises the stored-credential decrypt path end to end.
async function checkNxConnection(site) {
  try {
    const client = new NxWitnessClient({
      host: site.nx_host,
      username: site.nx_username,
      password: await decryptNxPassword(site.nx_password_encrypted),
      tlsCert: site.nx_tls_cert,
    });
    await client.verifyConnection();
    return [true, "Authenticated to Nx Witness via /rest/v2/login/sessions"];
  } catch (err) {
    if (err instanceof NxWitnessError) {
      return [false, "Site created, but the Nx Witness server rejected the credentials."];
    }
    return [false, "Site created, but the Nx Witness server could not be reached."];
  }
}

async function verifySitesExist(siteIds) {
  const found = await Promise.all(siteIds.map((id) => getSite(id)));
  const missing = siteIds.filter((_, i) => !found[i]);
  if (missing.length) {
    throw new HttpError(404, `Site(s) not found: ${missing.join(", ")}`);
  }
}

async function buildSite(body, organizationId) {
  if (await getSiteByToken(body.site_token)) {
    throw new HttpError(409, "A site with this token already exists");
  }
  const site = {
    id: newId(),
    name: body.name,
    site_token: body.site_token,
    organization_id: organizationId,
    nx_host: body.nx_host,
    nx_username: body.nx_username,
    nx_password_encrypted: await encryptNxPassword(body.nx_password),
    nx_tls_cert: body.nx_tls_cert ?? null,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
  };
  await putSite(site);
  const [ok, detail] = await checkNxConnection(site);
  return createSiteResponse(site, ok, detail);
}

// ---- organizations ------------------------------------------------------

// Map user records -> adminUserListItem[], resolving org names + each user's site
// names. `orgNameFor(orgId)` returns the org's display name.
async function usersToListItems(users, orgNameFor) {
  const siteName = new Map((await listAllSites()).map((s) => [s.id, s.name]));
  return Promise.all(
    users.map(async (u) => {
      const siteIds = await listSiteIdsForUser(u.id);
      const userSites = siteIds
        .map((id) => ({ id, name: siteName.get(id) }))
        .filter((s) => s.name !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(siteSummary);
      return adminUserListItem(u, orgNameFor(u.organization_id), userSites);
    })
  );
}

// Paginated when ?limit is present ({ items, next_cursor }); else the full list
// (used by the org-filter dropdowns that need every org).
async function listOrgs({ query }) {
  if (query.limit) {
    const { items, cursor } = await listOrganizationsPage({
      limit: pageLimit(query.limit),
      cursor: query.cursor,
    });
    return { items: items.map(organizationResponse), next_cursor: cursor };
  }
  return (await listOrganizations()).map(organizationResponse);
}

async function createOrg({ body }) {
  return organizationResponse(
    await putOrganization({ id: newId(), name: body.name, is_test: body.is_test ?? false })
  );
}

async function getOrg({ params }) {
  const org = await getOrganization(params.organization_id);
  if (!org) throw new HttpError(404, "Organization not found");
  return organizationResponse(org);
}

// Superuser edit of ANY org: rename and/or change the footage policy. A footage
// policy change emails the org's site_admins + records who/when (shared with the
// site-admin /settings path via applyFootagePolicy/notifyOrgSettingsChanged).
async function updateOrg({ user, params, body }) {
  const org = await getOrganization(params.organization_id);
  if (!org) throw new HttpError(404, "Organization not found");
  if (body.name !== undefined) org.name = body.name;
  if (body.is_test !== undefined) org.is_test = body.is_test;
  if (body.workflow_config !== undefined) org.workflow_config = body.workflow_config;
  const changes = applyFootagePolicy(org, body, user);
  await putOrganization(org);
  await notifyOrgSettingsChanged({ org, changes, actor: user });
  return organizationResponse(org);
}

// One page of a specific org's users (org-detail view).
async function listOrgUsersAdmin({ params, query }) {
  const org = await getOrganization(params.organization_id);
  if (!org) throw new HttpError(404, "Organization not found");
  const { items, cursor } = await listUsersByOrgPage(params.organization_id, {
    limit: pageLimit(query.limit),
    cursor: query.cursor,
  });
  return { items: await usersToListItems(items, () => org.name), next_cursor: cursor };
}

// Network-wide totals for the super_admin dashboard KPI tiles.
async function getStats({ user }) {
  // Cheap count-scans unless we must exclude test-org data for this superadmin.
  if (!shouldHideTestData(user)) {
    const [organizations, centres, users] = await Promise.all([
      countOrganizations(),
      countSites(),
      countUsers(),
    ]);
    return { organizations, centres, users };
  }
  // Hiding test orgs: aggregate from full lists so counts exclude them.
  const [orgs, sites, users] = await Promise.all([
    listOrganizations(),
    listAllSites(),
    listAllUsers(),
  ]);
  const test = testOrgIdsFrom(orgs);
  return {
    organizations: orgs.filter((o) => !test.has(o.id)).length,
    centres: sites.filter((s) => !test.has(s.organization_id)).length,
    users: users.filter((u) => !test.has(u.organization_id)).length,
  };
}

// Superuser self-preference: toggle whether test-org data shows in their views.
// Writes to the caller's OWN user record (id from the token), so a superuser can
// never change another user's preference.
async function updatePreferences({ user, body }) {
  const u = await getUser(user.id);
  if (!u) throw new HttpError(404, "User not found");
  u.show_test_data = !!body.show_test_data;
  await putUser(u);
  return { show_test_data: u.show_test_data };
}

async function deleteOrg({ params }) {
  const org = await getOrganization(params.organization_id);
  if (!org) throw new HttpError(404, "Organization not found");
  if ((await listSitesByOrg(params.organization_id)).length) {
    throw new HttpError(409, "Cannot delete organization with existing sites. Delete all sites first.");
  }
  if ((await listUsersByOrg(params.organization_id)).length) {
    throw new HttpError(409, "Cannot delete organization with existing users. Delete all users first.");
  }
  await deleteOrganization(params.organization_id);
}

// ---- sites --------------------------------------------------------------
async function createSite({ body }) {
  if (!(await getOrganization(body.organization_id))) {
    throw new HttpError(404, "Organization not found");
  }
  return buildSite(body, body.organization_id);
}

async function createSiteInOrg({ params, body }) {
  if (!(await getOrganization(params.organization_id))) {
    throw new HttpError(404, "Organization not found");
  }
  return buildSite(body, params.organization_id);
}

// All sites across all orgs. ?organization_id= filters to one org; ?limit=
// paginates ({ items, next_cursor }), else returns the full array (backward compat).
async function listAllSitesAdmin({ query }) {
  const orgs = await listOrganizations();
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const toItem = (s) => adminSiteListItem(s, orgName.get(s.organization_id));
  if (query.limit) {
    const page = query.organization_id
      ? await listSitesByOrgPage(query.organization_id, {
          limit: pageLimit(query.limit),
          cursor: query.cursor,
        })
      : await listAllSitesPage({ limit: pageLimit(query.limit), cursor: query.cursor });
    return { items: page.items.map(toItem), next_cursor: page.cursor };
  }
  const sites = query.organization_id
    ? await listSitesByOrg(query.organization_id)
    : await listAllSites();
  return sites.map(toItem);
}

async function listOrgSites({ params }) {
  const org = await getOrganization(params.organization_id);
  if (!org) throw new HttpError(404, "Organization not found");
  const sites = await listSitesByOrg(params.organization_id);
  return sites.map((s) => adminSiteListItem(s, org.name));
}

async function testConnection({ params }) {
  const site = await getSite(params.site_id);
  if (!site) throw new HttpError(404, "Site not found");
  try {
    const client = new NxWitnessClient({
      host: site.nx_host,
      username: site.nx_username,
      password: await decryptNxPassword(site.nx_password_encrypted),
      tlsCert: site.nx_tls_cert,
    });
    await client.verifyConnection();
  } catch (err) {
    if (err instanceof NxWitnessError) {
      throw new HttpError(502, "The site's Nx Witness server rejected the credentials.");
    }
    // Includes credential-decrypt failures (e.g. misconfigured encryption key).
    throw new HttpError(502, "Could not reach the site's Nx Witness server.");
  }
  return {
    ok: true,
    host: site.nx_host,
    detail: "Authenticated to Nx Witness via /rest/v2/login/sessions",
  };
}

async function listCameras({ params }) {
  const site = await getSite(params.site_id);
  if (!site) throw new HttpError(404, "Site not found");
  let devices;
  try {
    const client = new NxWitnessClient({
      host: site.nx_host,
      username: site.nx_username,
      password: await decryptNxPassword(site.nx_password_encrypted),
      tlsCert: site.nx_tls_cert,
    });
    devices = await client.listDevices();
  } catch (err) {
    if (err instanceof NxWitnessError) {
      throw new HttpError(502, "The site's Nx Witness server rejected the request (check credentials/host).");
    }
    // Includes credential-decrypt failures (e.g. misconfigured encryption key).
    throw new HttpError(502, "Could not reach the site's Nx Witness server.");
  }
  return devices.filter((d) => d && typeof d === "object").map(cameraResponse);
}

async function deleteSiteAdmin({ params }) {
  const site = await getSite(params.site_id);
  if (!site) throw new HttpError(404, "Site not found");
  if (await hasAlertsForSite(params.site_id)) {
    throw new HttpError(409, "Cannot delete site with existing alerts.");
  }
  await deleteAllForSite(params.site_id); // cascade access permissions (setup data)
  await deleteSite(params.site_id);
}

// ---- users --------------------------------------------------------------
// All users across all orgs. ?organization_id= filters to one org; ?limit=
// paginates ({ items, next_cursor }), else returns the full array (backward compat
// - findUserByEmail relies on the array shape).
async function listUsers({ user, query }) {
  const orgs = await listOrganizations();
  const nameFor = ((m) => (id) => m.get(id))(new Map(orgs.map((o) => [o.id, o.name])));
  // Hide users belonging to test orgs (superadmin with the pref off).
  const test = shouldHideTestData(user) ? testOrgIdsFrom(orgs) : null;
  const dropTest = (arr) => (test ? arr.filter((u) => !test.has(u.organization_id)) : arr);
  if (query.limit) {
    const page = query.organization_id
      ? await listUsersByOrgPage(query.organization_id, {
          limit: pageLimit(query.limit),
          cursor: query.cursor,
        })
      : await listAllUsersPage({ limit: pageLimit(query.limit), cursor: query.cursor });
    return { items: await usersToListItems(dropTest(page.items), nameFor), next_cursor: page.cursor };
  }
  const users = query.organization_id
    ? await listUsersByOrg(query.organization_id)
    : await listAllUsers();
  return usersToListItems(dropTest(users), nameFor);
}

async function createUser({ body }) {
  if (await getUserByEmail(body.email)) throw new HttpError(409, "Email already registered");
  if (!(await getOrganization(body.organization_id))) {
    throw new HttpError(404, "Organization not found");
  }
  const siteIds = [...new Set(body.site_ids || [])];
  if (siteIds.length) await verifySitesExist(siteIds);

  const user = {
    id: newId(),
    email: body.email,
    hashed_password: hashPassword(body.password),
    full_name: body.full_name,
    role: body.role,
    organization_id: body.organization_id,
    account_created: today(),
    is_active: true,
  };
  await putUser(user);
  await Promise.all(
    siteIds.map((sid) => putPermission({ id: newId(), user_id: user.id, site_id: sid }))
  );

  // Best-effort invite (no-op when Mailtrap isn't configured).
  try {
    const token = await createSetPasswordToken(user.id, user.hashed_password);
    await sendSetPasswordEmail({ toEmail: user.email, fullName: user.full_name, token });
  } catch (err) {
    console.warn("set-password email failed:", err.message);
  }
  return createUserResponse(user);
}

async function resendInvite({ params }) {
  const user = await getUser(params.user_id);
  if (!user) throw new HttpError(404, "User not found");
  try {
    const token = await createSetPasswordToken(user.id, user.hashed_password);
    await sendSetPasswordEmail({ toEmail: user.email, fullName: user.full_name, token });
  } catch (err) {
    console.warn("resend invite email failed:", err.message);
  }
  return { status: "sent" };
}

// Partial update with per-field authorization against the caller's token.
async function updateUser({ user: caller, body }) {
  const target = await getUser(body.id);
  if (!target) throw new HttpError(404, "User not found");

  const provided = Object.keys(body).filter(
    (f) => f !== "id" && body[f] !== undefined && body[f] !== null
  );
  if (!provided.length) throw new HttpError(400, "No updatable fields provided");
  if (provided.includes("password") && !body.password.trim()) {
    throw new HttpError(400, "Password must not be empty");
  }

  const isSelf = target.id === caller.id;
  const callerIsSuperuser = caller.role === "superuser";
  const outranksTarget = ROLE_RANK[caller.role] > ROLE_RANK[target.role];

  const forbidden = provided.filter((field) => {
    if (field === "full_name" || field === "password") return !isSelf;
    if (field === "role" || field === "organization_id") return !callerIsSuperuser;
    if (field === "email" || field === "site_ids") return !outranksTarget;
    return true;
  });
  if (forbidden.length) {
    throw new HttpError(403, `Not permitted to update: ${forbidden.sort().join(", ")}`);
  }

  if (provided.includes("email")) {
    const clash = await getUserByEmail(body.email);
    if (clash && clash.id !== target.id) throw new HttpError(409, "Email already registered");
  }
  if (provided.includes("organization_id") && !(await getOrganization(body.organization_id))) {
    throw new HttpError(404, "Organization not found");
  }
  let newSiteIds = null;
  if (provided.includes("site_ids")) {
    newSiteIds = [...new Set(body.site_ids)];
    if (newSiteIds.length) await verifySitesExist(newSiteIds);
  }

  if (provided.includes("email")) target.email = body.email;
  if (provided.includes("full_name")) target.full_name = body.full_name;
  if (provided.includes("password")) target.hashed_password = hashPassword(body.password);
  if (provided.includes("role")) target.role = body.role;
  if (provided.includes("organization_id")) target.organization_id = body.organization_id;
  await putUser(target);

  if (newSiteIds !== null) {
    await deleteAllForUser(target.id); // replace site access wholesale
    await Promise.all(
      newSiteIds.map((sid) => putPermission({ id: newId(), user_id: target.id, site_id: sid }))
    );
  }

  const siteIds = await listSiteIdsForUser(target.id);
  const sites = (await getSitesByIdsForSummary(siteIds))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(siteSummary);
  return updateUserResponse(target, sites);
}

async function getSitesByIdsForSummary(ids) {
  const sites = await Promise.all(ids.map((id) => getSite(id)));
  return sites.filter(Boolean);
}

// Fire a diagnostic email to the `testEmailTo` secret — verifies the email
// pipeline (SES in prod) end to end. Returns the provider/result detail.
async function testEmail() {
  const result = await sendTestEmail();
  return result; // { provider, from, to, sent, messageId?, error? }
}

async function deleteUserAdmin({ params }) {
  const user = await getUser(params.user_id);
  if (!user) throw new HttpError(404, "User not found");
  // Audit trail survives: Alert.decided_by and footage log identity are
  // denormalised/kept. Permissions and device tokens are setup/session data.
  await deleteAllForUser(params.user_id);
  await deleteTokensForUser(params.user_id);
  await deleteUser(params.user_id);
}

// Settings "Send test alert" — accurately simulate an Nx webhook capture. Rather
// than duplicating alert creation, it builds a webhook-shaped payload and invokes
// the REAL webhook handler (receiveAlert) in-process, signed with the actual
// webhook secret. So the alert flows through the identical path a live CV event
// would: secret check -> site_token resolution -> putAlert -> WebSocket broadcast.
// The endpoint itself is authed by the caller's JWT (site_admin+); the webhook
// secret never leaves the backend.
const TEST_ALERT_TYPES = [
  "child_alone",
  "person_alone_with_child",
  "child_in_no_go_zone",
  "blacklisted_vehicle",
  "child_alone_with_adult",
];

// Resolve a real camera for the site by asking its Nx VMS (no hardcoded id).
// Uses the org's whitelisted Nx credentials + the site's nx_host, and returns
// the first configured device — for the test site that's the Art of Logic camera
// reachable over the Tailscale funnel.
async function resolveSiteCamera(site) {
  const creds = await getOrgNxCredentials(site.organization_id);
  if (!creds || !site.nx_host) {
    throw new HttpError(
      422,
      "Site has no Nx credentials/host configured — can't resolve a camera for the alert"
    );
  }
  let devices;
  try {
    const client = new NxWitnessClient({
      host: site.nx_host,
      username: creds.username,
      password: creds.password,
      tlsCert: site.nx_tls_cert,
    });
    devices = await client.listDevices();
  } catch (err) {
    if (err instanceof NxWitnessError) {
      throw new HttpError(502, "The site's Nx VMS rejected the request (check credentials/host).");
    }
    throw new HttpError(502, "Could not reach the site's Nx VMS to resolve a camera.");
  }
  const cam = (devices || []).find((d) => d && d.id);
  if (!cam) throw new HttpError(422, "No cameras configured on the site's Nx VMS.");
  return cam.id;
}

async function testAlert({ user, body }) {
  // Resolve a site the caller is allowed to push to.
  let siteId = body.site_id;
  if (siteId) {
    if (!(await userCanAccessSite(user, siteId))) throw new HttpError(403, "Access denied");
  } else {
    const accessible = await getAccessibleSiteIds(user); // null = superuser (all)
    if (accessible && accessible.length) {
      siteId = accessible[0];
    } else {
      const all = await listAllSites();
      if (all.length) siteId = all[0].id;
    }
  }
  if (!siteId) throw new HttpError(422, "No site available to attach a test alert to");
  const site = await getSite(siteId);
  if (!site) throw new HttpError(404, "Site not found");
  if (!site.site_token) {
    throw new HttpError(422, "Site has no site_token — cannot simulate a webhook for it");
  }

  const type =
    body.alert_type ||
    TEST_ALERT_TYPES[Math.floor(Math.random() * TEST_ALERT_TYPES.length)];
  // Camera comes from the site's VMS, not a constant (unless the caller pinned one).
  const cameraId = body.camera_id || (await resolveSiteCamera(site));
  const end = new Date();
  const start = new Date(end.getTime() - 60_000); // 60s window (standard clip length)

  // Simulate the CV device calling POST /api/v1/webhooks/alert: same body shape,
  // signed with the real webhook secret, dispatched through receiveAlert().
  const webhookBody = {
    site_token: site.site_token,
    camera_id: cameraId,
    alert_type: type,
    start_timestamp: start.toISOString(),
    end_timestamp: end.toISOString(),
    nx_bookmark_id: null,
  };
  const webhookSecret = await getSecret("webhookSecret");
  const alert = await receiveAlert({
    event: { headers: { "x-webhook-secret": webhookSecret } },
    body: webhookBody,
  });
  return { ...alert, site_name: site.name };
}

// On-demand footage archiver trigger (also runs on a schedule; see archiver.js).
async function runArchiveSweep() {
  return sweep();
}

// ---- Site-admin org user management (create + list; org/site/rank scoped) ----

// List the users in the caller's organization, each with the sites they are
// permitted on. site_admin+, scoped to the caller's own org (SECURITY_RULES 1.2).
async function listOrgUsers({ user: caller }) {
  const orgId = caller.organization_id;
  if (!orgId) throw new HttpError(400, "No organization for this account");
  const [users, orgSites] = await Promise.all([
    listUsersByOrg(orgId),
    listSitesByOrg(orgId),
  ]);
  const siteName = new Map(orgSites.map((s) => [s.id, s.name]));
  const rows = await Promise.all(
    users.map(async (u) => {
      const ids = await listSiteIdsForUser(u.id);
      const sites = ids
        .filter((id) => siteName.has(id))
        .map((id) => ({ id, name: siteName.get(id) }));
      return orgUserListItem(u, sites);
    })
  );
  rows.sort((a, b) => a.full_name.localeCompare(b.full_name));
  return rows;
}

// Create a new user in the caller's org. Enforces (SECURITY_RULES 1.2 / 1.5):
//   - org = the caller's org (never cross-org; taken from the token)
//   - role <= the caller's rank (schema already blocks superuser)
//   - assigned sites are any site IN the caller's org (a site_admin administers
//     the whole org, not just sites they personally hold - see SECURITY_DECISIONS
//     Entry 012); cross-org is impossible since orgId comes from the token.
// Onboarding is invite-based: a random password is set + a set-password email sent.
async function createOrgUser({ user: caller, body }) {
  const orgId = caller.organization_id;
  if (!orgId) throw new HttpError(400, "No organization for this account");

  if (ROLE_RANK[body.role] > ROLE_RANK[caller.role]) {
    throw new HttpError(403, "Cannot create a user with a role above your own");
  }

  const siteIds = [...new Set(body.site_ids || [])];
  // Any site in the caller's org may be assigned (org-membership is the boundary,
  // not the caller's personal grants). orgId is token-derived, so this cannot
  // reach another org's sites. See SECURITY_DECISIONS Entry 012.
  if (siteIds.length) {
    const orgSiteIds = new Set((await listSitesByOrg(orgId)).map((s) => s.id));
    if (siteIds.some((s) => !orgSiteIds.has(s))) {
      throw new HttpError(404, "Unknown site for this organization");
    }
  }

  if (await getUserByEmail(body.email)) {
    throw new HttpError(409, "Email already registered");
  }

  const user = {
    id: newId(),
    email: body.email,
    // Invite-based: unguessable until the user sets their own via the email link.
    hashed_password: hashPassword(newId() + newId()),
    full_name: body.full_name,
    phone: body.phone || null,
    role: body.role,
    organization_id: orgId,
    account_created: today(),
    is_active: true,
  };
  await putUser(user);
  await Promise.all(
    siteIds.map((sid) => putPermission({ id: newId(), user_id: user.id, site_id: sid }))
  );

  try {
    const token = await createSetPasswordToken(user.id, user.hashed_password);
    await sendSetPasswordEmail({ toEmail: user.email, fullName: user.full_name, token });
  } catch (err) {
    console.warn("set-password email failed:", err.message);
  }
  return createUserResponse(user);
}

// Edit an org user's role and/or sites (PATCH /api/v1/users/{user_id}). Same
// scoping as create (SECURITY_RULES 1.2/1.5): target must be in the caller's
// org, not the caller themselves, and not ranked above the caller; role is
// capped to the caller's rank; site_ids may be any sites IN the caller's org
// (Entry 012) and REPLACE the user's current permission set.
async function updateOrgUser({ user: caller, params, body }) {
  const isSuper = caller.role === "superuser";
  const target = await getUser(params.user_id);
  if (!target) throw new HttpError(404, "User not found");
  // A site_admin is scoped to their own org; a superuser may edit a user in ANY
  // org (platform CRM), and site_ids are validated against the TARGET's org below.
  const orgId = isSuper ? target.organization_id : caller.organization_id;
  if (!orgId) throw new HttpError(400, "No organization for this account");
  if (!isSuper && target.organization_id !== orgId) {
    throw new HttpError(404, "User not found");
  }
  if (target.id === caller.id) {
    throw new HttpError(403, "You cannot edit your own account here");
  }
  if (ROLE_RANK[target.role] > ROLE_RANK[caller.role]) {
    throw new HttpError(403, "Cannot edit a user ranked above you");
  }

  if (body.role !== undefined) {
    if (ROLE_RANK[body.role] > ROLE_RANK[caller.role]) {
      throw new HttpError(403, "Cannot set a role above your own");
    }
    target.role = body.role;
  }

  if (body.full_name !== undefined) target.full_name = body.full_name;
  // Email change: enforce uniqueness (email-index GSI isn't unique, and login
  // resolves accounts by email). The self-match term keeps a no-op email edit
  // idempotent instead of a false 409. Mirrors the superuser updateUser guard.
  if (body.email !== undefined && body.email !== target.email) {
    const clash = await getUserByEmail(body.email);
    if (clash && clash.id !== target.id) {
      throw new HttpError(409, "Email already registered");
    }
    target.email = body.email;
  }

  let sites = null;
  if (body.site_ids !== undefined) {
    const siteIds = [...new Set(body.site_ids)];
    // Any site in the caller's org may be assigned (see createOrgUser + Entry 012).
    const orgSites = await listSitesByOrg(orgId);
    const orgSiteIds = new Set(orgSites.map((s) => s.id));
    if (siteIds.some((s) => !orgSiteIds.has(s))) {
      throw new HttpError(404, "Unknown site for this organization");
    }
    await deleteAllForUser(target.id);
    await Promise.all(
      siteIds.map((sid) => putPermission({ id: newId(), user_id: target.id, site_id: sid }))
    );
    const nameById = new Map(orgSites.map((s) => [s.id, s.name]));
    sites = siteIds.filter((id) => nameById.has(id)).map((id) => ({ id, name: nameById.get(id) }));
  }

  await putUser(target);

  if (sites === null) {
    const [ids, orgSites] = await Promise.all([
      listSiteIdsForUser(target.id),
      listSitesByOrg(orgId),
    ]);
    const nameById = new Map(orgSites.map((s) => [s.id, s.name]));
    sites = ids.filter((id) => nameById.has(id)).map((id) => ({ id, name: nameById.get(id) }));
  }
  return orgUserListItem(target, sites);
}

export const handler = createRouter({
  "POST /api/v1/admin/footage/archive-sweep": {
    fn: runArchiveSweep,
    auth: "superuser",
  },
  // Site-admin org user management (org/site/rank scoped; see handlers above).
  "GET /api/v1/users": { fn: listOrgUsers, auth: "site_admin" },
  "POST /api/v1/users": {
    fn: createOrgUser,
    auth: "site_admin",
    schema: orgUserCreateSchema,
    status: 201,
  },
  "PATCH /api/v1/users/{user_id}": {
    fn: updateOrgUser,
    auth: "site_admin",
    schema: orgUserUpdateSchema,
  },
  "GET /api/v1/admin/stats": { fn: getStats, auth: "superuser" },
  "PATCH /api/v1/admin/preferences": {
    fn: updatePreferences,
    auth: "superuser",
    schema: preferencesSchema,
  },
  "GET /api/v1/admin/organizations": { fn: listOrgs, auth: "superuser" },
  "POST /api/v1/admin/organizations": {
    fn: createOrg,
    auth: "superuser",
    schema: createOrganizationSchema,
    status: 201,
  },
  "GET /api/v1/admin/organizations/{organization_id}": { fn: getOrg, auth: "superuser" },
  "PATCH /api/v1/admin/organizations/{organization_id}": {
    fn: updateOrg,
    auth: "superuser",
    schema: adminOrgUpdateSchema,
  },
  "DELETE /api/v1/admin/organizations/{organization_id}": {
    fn: deleteOrg,
    auth: "superuser",
    status: 204,
  },
  "GET /api/v1/admin/organizations/{organization_id}/sites": {
    fn: listOrgSites,
    auth: "superuser",
  },
  "GET /api/v1/admin/organizations/{organization_id}/users": {
    fn: listOrgUsersAdmin,
    auth: "superuser",
  },
  "POST /api/v1/admin/organizations/{organization_id}/sites": {
    fn: createSiteInOrg,
    auth: "superuser",
    schema: createSiteInOrgSchema,
    status: 201,
  },
  "POST /api/v1/admin/sites": {
    fn: createSite,
    auth: "superuser",
    schema: createSiteSchema,
    status: 201,
  },
  "GET /api/v1/admin/sites": { fn: listAllSitesAdmin, auth: "superuser" },
  "POST /api/v1/admin/sites/{site_id}/test-connection": {
    fn: testConnection,
    auth: "superuser",
  },
  "GET /api/v1/admin/sites/{site_id}/cameras": { fn: listCameras, auth: "superuser" },
  "DELETE /api/v1/admin/sites/{site_id}": { fn: deleteSiteAdmin, auth: "superuser", status: 204 },
  "GET /api/v1/admin/users": { fn: listUsers, auth: "superuser" },
  "POST /api/v1/admin/users": {
    fn: createUser,
    auth: "superuser",
    schema: createUserSchema,
    status: 201,
  },
  "POST /api/v1/admin/users/{user_id}/resend-invite": {
    fn: resendInvite,
    auth: "superuser",
    status: 202,
  },
  "PUT /api/v1/admin/users": { fn: updateUser, auth: "user", schema: updateUserSchema },
  "DELETE /api/v1/admin/users/{user_id}": { fn: deleteUserAdmin, auth: "superuser", status: 204 },
  "POST /api/v1/admin/test-email": { fn: testEmail, auth: "superuser" },
  "POST /api/v1/admin/test-alert": {
    fn: testAlert,
    auth: "site_admin",
    schema: testAlertSchema,
    status: 201,
  },
});
