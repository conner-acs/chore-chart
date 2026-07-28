import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId } from "../lib/ids.js";
import { getAccessibleSiteIds, userCanAccessSite } from "../lib/permissions.js";
import {
  getSite,
  getSiteByToken,
  getSitesByIds,
  listSitesByOrg,
  listAllSites,
  putSite,
} from "../lib/repo/sites.js";
import { getUser, getUserByEmail } from "../lib/repo/users.js";
import { getOrganization } from "../lib/repo/organizations.js";
import {
  getPermission,
  putPermission,
  deletePermission,
  listUserIdsForSite,
} from "../lib/repo/permissions.js";
import { listLogsBySite } from "../lib/repo/footageLog.js";
import { NxWitnessClient } from "../services/nxWitness.js";
import { getOrgNxCredentials } from "../lib/secrets.js";
import { siteResponse, siteUserResponse, auditLogEntryResponse } from "../lib/presenters.js";
import {
  addUserToSiteSchema,
  orgSiteCreateSchema,
  orgSiteUpdateSchema,
} from "../schemas/index.js";

// Turn a display name into a SITE_TOKEN-valid slug: lowercase, a-z0-9 runs joined
// by single hyphens, no leading/trailing hyphen, >=2 chars. Falls back to "site".
const slugify = (name) => {
  const s = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s.length >= 2 ? s : "site";
};

// Create a site in the caller's OWN org (site_admin self-serve). Deliberately
// VMS-less: no nx_host/username/password - those infra secrets are provisioned
// by a superuser later, and every live VMS path already tolerates a missing host
// (listSiteCameras returns [], footage resolves 422 until wired). org is
// token-derived so cross-org is impossible. site_token is auto-derived from the
// name (numeric suffix on collision) unless the caller supplies a valid one.
async function createOrgSite({ user: caller, body }) {
  // A superuser may create a centre in ANY org (org id supplied in the body). A
  // site_admin always creates in their own token-derived org (body org id ignored).
  let orgId = caller.organization_id;
  if (caller.role === "superuser" && body.organization_id) {
    if (!(await getOrganization(body.organization_id))) {
      throw new HttpError(404, "Organization not found");
    }
    orgId = body.organization_id;
  }
  if (!orgId) throw new HttpError(400, "No organization for this account");

  const base = body.site_token || slugify(body.name);
  let token = base;
  let n = 1;
  while (await getSiteByToken(token)) {
    if (body.site_token) {
      throw new HttpError(409, "A site with this token already exists");
    }
    n += 1;
    token = `${base}-${n}`;
  }

  const site = {
    id: newId(),
    name: body.name,
    site_token: token,
    organization_id: orgId,
    nx_tls_cert: null,
    address: body.address ?? null,
    latitude: body.latitude ?? null,
    longitude: body.longitude ?? null,
  };
  await putSite(site);
  return siteResponse(site);
}

// Edit a site's name/address/coordinates. A site_admin may only touch a site in
// their OWN org (boundary enforced via the record's organization_id); a superuser
// may edit ANY org's site (platform CRM), mirroring createOrgSite. nx_* secrets,
// site_token, and organization_id are never mutated here for either role.
async function updateOrgSite({ user: caller, params, body }) {
  const isSuper = caller.role === "superuser";
  if (!isSuper && !caller.organization_id) {
    throw new HttpError(400, "No organization for this account");
  }
  const site = await getSite(params.site_id);
  if (!site || (!isSuper && site.organization_id !== caller.organization_id)) {
    throw new HttpError(404, "Site not found");
  }
  if (body.name !== undefined) site.name = body.name;
  if (body.address !== undefined) site.address = body.address;
  if (body.latitude !== undefined) site.latitude = body.latitude;
  if (body.longitude !== undefined) site.longitude = body.longitude;
  await putSite(site);
  return siteResponse(site);
}

async function listSites({ user, query }) {
  const scope = query.scope || "permitted";
  if (scope !== "permitted" && scope !== "organization") {
    throw new HttpError(422, "scope must be 'permitted' or 'organization'");
  }

  let sites;
  if (scope === "organization") {
    sites = await listSitesByOrg(user.organization_id);
  } else {
    const accessible = await getAccessibleSiteIds(user); // null = superuser
    sites = accessible === null ? await listAllSites() : await getSitesByIds(accessible);
    sites.sort((a, b) => a.name.localeCompare(b.name));
  }
  return sites.map(siteResponse);
}

async function listSiteUsers({ user, params }) {
  if (!(await userCanAccessSite(user, params.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  const userIds = await listUserIdsForSite(params.site_id);
  const users = (await Promise.all(userIds.map((id) => getUser(id)))).filter(Boolean);
  users.sort((a, b) => a.full_name.localeCompare(b.full_name));
  return users.map(siteUserResponse);
}

async function addUserToSite({ user, params, body }) {
  if (!(await userCanAccessSite(user, params.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (!(await getSite(params.site_id))) throw new HttpError(404, "Site not found");

  const target = await getUserByEmail(body.email);
  if (!target) throw new HttpError(404, "User not found");

  if (await getPermission(target.id, params.site_id)) {
    throw new HttpError(409, "User already has access to this site");
  }
  await putPermission({ id: newId(), user_id: target.id, site_id: params.site_id });
  return siteUserResponse(target);
}

async function removeUserFromSite({ user, params }) {
  if (!(await userCanAccessSite(user, params.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  if (!(await getPermission(params.user_id, params.site_id))) {
    throw new HttpError(404, "User does not have access to this site");
  }
  await deletePermission(params.user_id, params.site_id);
  // 204 No Content
}

async function getAuditLog({ user, params, query }) {
  if (!(await userCanAccessSite(user, params.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  const userId = query.user_id || null;
  const limit = Math.min(parseInt(query.limit ?? "100", 10) || 100, 500);
  const offset = Math.max(parseInt(query.offset ?? "0", 10) || 0, 0);

  let logs = await listLogsBySite(params.site_id); // newest first
  if (userId) logs = logs.filter((l) => l.user_id === userId);
  return logs.slice(offset, offset + limit).map(auditLogEntryResponse);
}

// Camera id -> name for a site, resolved live from its Nx VMS. Accessible to any
// user permitted on the site (unlike the superuser-only admin cameras endpoint),
// so the operator UI can label alerts/notifications with the real camera name
// instead of a raw id. Returns [] if the VMS isn't configured/reachable — the
// client then falls back to the camera id, never a fabricated label.
async function listSiteCameras({ user, params }) {
  if (!(await userCanAccessSite(user, params.site_id))) {
    throw new HttpError(403, "Access denied");
  }
  const site = await getSite(params.site_id);
  if (!site) throw new HttpError(404, "Site not found");
  const creds = await getOrgNxCredentials(site.organization_id);
  if (!creds || !site.nx_host) return [];
  try {
    const client = new NxWitnessClient({
      host: site.nx_host,
      username: creds.username,
      password: creds.password,
      tlsCert: site.nx_tls_cert,
    });
    const devices = await client.listDevices();
    return (devices || [])
      .filter((d) => d && d.id)
      .map((d) => ({ id: d.id, name: d.name || d.id }));
  } catch (err) {
    // Any failure (VMS down, bad creds) yields the id fallback — never fail the UI.
    console.warn("listSiteCameras: VMS unreachable:", err.message);
    return [];
  }
}

export const handler = createRouter({
  "GET /api/v1/sites": { fn: listSites, auth: "user" },
  "POST /api/v1/sites": {
    fn: createOrgSite,
    auth: "site_admin",
    schema: orgSiteCreateSchema,
    status: 201,
  },
  "PATCH /api/v1/sites/{site_id}": {
    fn: updateOrgSite,
    auth: "site_admin",
    schema: orgSiteUpdateSchema,
  },
  "GET /api/v1/sites/{site_id}/cameras": { fn: listSiteCameras, auth: "user" },
  "GET /api/v1/sites/{site_id}/users": { fn: listSiteUsers, auth: "site_admin" },
  "POST /api/v1/sites/{site_id}/users": {
    fn: addUserToSite,
    auth: "site_admin",
    schema: addUserToSiteSchema,
    status: 201,
  },
  "DELETE /api/v1/sites/{site_id}/users/{user_id}": {
    fn: removeUserFromSite,
    auth: "site_admin",
    status: 204,
  },
  "GET /api/v1/sites/{site_id}/audit-log": { fn: getAuditLog, auth: "site_admin" },
});
