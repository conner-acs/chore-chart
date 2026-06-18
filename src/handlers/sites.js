import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { newId } from "../lib/ids.js";
import { getAccessibleSiteIds, userCanAccessSite } from "../lib/permissions.js";
import { getSite, getSitesByIds, listSitesByOrg, listAllSites } from "../lib/repo/sites.js";
import { getUser, getUserByEmail } from "../lib/repo/users.js";
import {
  getPermission,
  putPermission,
  deletePermission,
  listUserIdsForSite,
} from "../lib/repo/permissions.js";
import { listLogsBySite } from "../lib/repo/footageLog.js";
import { siteResponse, siteUserResponse, auditLogEntryResponse } from "../lib/presenters.js";
import { addUserToSiteSchema } from "../schemas/index.js";

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

export const handler = createRouter({
  "GET /api/v1/sites": { fn: listSites, auth: "user" },
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
