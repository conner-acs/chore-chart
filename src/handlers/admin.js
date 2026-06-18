import { createRouter, ROLE_RANK } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId } from "../lib/ids.js";
import { hashPassword, createSetPasswordToken } from "../lib/auth.js";
import { encryptNxPassword, decryptNxPassword } from "../lib/fernet.js";
import { NxWitnessClient, NxWitnessError } from "../services/nxWitness.js";
import { sendSetPasswordEmail, sendTestEmail } from "../services/email.js";
import {
  listOrganizations,
  getOrganization,
  putOrganization,
  deleteOrganization,
} from "../lib/repo/organizations.js";
import {
  getSite,
  getSiteByToken,
  listSitesByOrg,
  listAllSites,
  putSite,
  deleteSite,
} from "../lib/repo/sites.js";
import {
  getUser,
  getUserByEmail,
  listAllUsers,
  listUsersByOrg,
  putUser,
  deleteUser,
} from "../lib/repo/users.js";
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
  siteSummary,
  cameraResponse,
} from "../lib/presenters.js";
import {
  createOrganizationSchema,
  createSiteSchema,
  createSiteInOrgSchema,
  createUserSchema,
  updateUserSchema,
} from "../schemas/index.js";

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
async function listOrgs() {
  return (await listOrganizations()).map(organizationResponse);
}

async function createOrg({ body }) {
  return organizationResponse(await putOrganization({ id: newId(), name: body.name }));
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

async function listAllSitesAdmin() {
  const [sites, orgs] = await Promise.all([listAllSites(), listOrganizations()]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  return sites.map((s) => adminSiteListItem(s, orgName.get(s.organization_id)));
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
async function listUsers() {
  const [users, orgs, sites] = await Promise.all([
    listAllUsers(),
    listOrganizations(),
    listAllSites(),
  ]);
  const orgName = new Map(orgs.map((o) => [o.id, o.name]));
  const siteName = new Map(sites.map((s) => [s.id, s.name]));

  return Promise.all(
    users.map(async (u) => {
      const siteIds = await listSiteIdsForUser(u.id);
      const userSites = siteIds
        .map((id) => ({ id, name: siteName.get(id) }))
        .filter((s) => s.name !== undefined)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(siteSummary);
      return adminUserListItem(u, orgName.get(u.organization_id), userSites);
    })
  );
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

export const handler = createRouter({
  "GET /api/v1/admin/organizations": { fn: listOrgs, auth: "superuser" },
  "POST /api/v1/admin/organizations": {
    fn: createOrg,
    auth: "superuser",
    schema: createOrganizationSchema,
    status: 201,
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
});
