import { error, json, parseBody, HttpError } from "./response.js";
import { decodeToken } from "./auth.js";
import { getUser } from "./repo/users.js";

const ROLE_RANK = { operator: 1, site_admin: 2, superuser: 3 };
export { ROLE_RANK };

// Resolve the bearer token to an active user, or throw 401. Mirrors
// app/core/auth.get_current_user: refresh tokens are rejected as access tokens.
export async function getCurrentUser(event) {
  const header =
    event.headers?.authorization || event.headers?.Authorization || "";
  const [scheme, token] = header.split(" ");
  const invalid = new HttpError(401, "Invalid or expired token");
  if (scheme !== "Bearer" || !token) throw invalid;

  let payload;
  try {
    payload = await decodeToken(token);
  } catch {
    throw invalid;
  }
  if (payload.type === "refresh" || !payload.sub) throw invalid;

  const user = await getUser(payload.sub);
  if (!user || !user.is_active) throw invalid;
  return user;
}

function enforceRole(user, required) {
  if (required === "superuser" && user.role !== "superuser") {
    throw new HttpError(403, "Superuser access required");
  }
  if (
    required === "site_admin" &&
    user.role !== "site_admin" &&
    user.role !== "superuser"
  ) {
    throw new HttpError(403, "Site admin access required");
  }
}

// Wrap a route handler with auth, role gating, body validation, and uniform
// error handling. `fn` receives a context: { event, user, body, params, query }.
//
//   opts.auth   : "user" | "site_admin" | "superuser" (omit for public routes)
//   opts.schema : a Joi schema to validate+coerce the JSON body
//   opts.status : success status code (default 200)
export function makeHandler(opts, fn) {
  return async (event) => {
    try {
      const ctx = {
        event,
        params: event.pathParameters || {},
        query: event.queryStringParameters || {},
        user: null,
        body: undefined,
      };

      if (opts.auth) {
        ctx.user = await getCurrentUser(event);
        enforceRole(ctx.user, opts.auth);
      }

      if (opts.schema) {
        let raw;
        try {
          raw = parseBody(event);
        } catch {
          throw new HttpError(400, "Invalid JSON body");
        }
        const { value, error: vErr } = opts.schema.validate(raw, {
          abortEarly: false,
          stripUnknown: true,
        });
        if (vErr) {
          throw new HttpError(422, vErr.details.map((d) => d.message).join("; "));
        }
        ctx.body = value;
      }

      const result = await fn(ctx);
      // A handler may return a full response object (statusCode set) or a plain
      // value to be JSON-serialised with the configured success status.
      if (result && typeof result === "object" && "statusCode" in result) {
        return result;
      }
      return json(opts.status || 200, result);
    } catch (err) {
      if (err instanceof HttpError) return error(err.statusCode, err.detail);
      console.error("Unhandled error on", event.routeKey || event.rawPath, err);
      return error(500, "Internal server error");
    }
  };
}

// Build a single Lambda handler that dispatches on API Gateway's routeKey
// (e.g. "POST /api/v1/auth/login"). `routes` maps routeKey -> { fn, ...opts }.
export function createRouter(routes) {
  const wrapped = {};
  for (const [routeKey, { fn, ...opts }] of Object.entries(routes)) {
    wrapped[routeKey] = makeHandler(opts, fn);
  }
  return async (event) => {
    const handler = wrapped[event.routeKey];
    if (!handler) return error(404, "Not found");
    return handler(event);
  };
}
