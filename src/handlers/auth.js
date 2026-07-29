import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import {
  createAccessToken,
  createRefreshToken,
  createSetPasswordToken,
  decodeToken,
  hashPassword,
  verifyPassword,
  passwordFingerprint,
  SET_PASSWORD_PURPOSE,
} from "../lib/auth.js";
import { getUser, getUserByEmail, putUser } from "../lib/repo/users.js";
import { getOrganization } from "../lib/repo/organizations.js";
import { getOrgNxCredentials } from "../lib/secrets.js";
import { sendPasswordResetEmail } from "../services/email.js";
import { tokenResponse, userResponse } from "../lib/presenters.js";
import {
  loginSchema,
  refreshSchema,
  setPasswordSchema,
  forgotPasswordSchema,
} from "../schemas/index.js";

async function login({ body }) {
  const user = await getUserByEmail(body.email);
  // Deliberately vague — don't reveal whether the email exists.
  if (!user || !verifyPassword(body.password, user.hashed_password)) {
    throw new HttpError(401, "Invalid credentials");
  }
  if (!user.is_active) throw new HttpError(403, "Account is inactive");
  return tokenResponse(
    await createAccessToken(user.id),
    await createRefreshToken(user.id)
  );
}

async function refresh({ body }) {
  const invalid = new HttpError(401, "Invalid refresh token");
  let payload;
  try {
    payload = await decodeToken(body.refresh_token);
  } catch {
    throw invalid;
  }
  if (payload.type !== "refresh" || !payload.sub) throw invalid;

  const user = await getUser(payload.sub);
  if (!user || !user.is_active) throw invalid;
  return tokenResponse(
    await createAccessToken(user.id),
    await createRefreshToken(user.id)
  );
}

// Start a self-service password reset. Emails a scoped, single-use link (the
// same token + /set-password.html page the invite flow uses) via SES.
// Deliberately always returns the same 200 response whether or not the email
// maps to an account — no user enumeration, and delivery failures are swallowed.
async function forgotPassword({ body }) {
  const generic = {
    detail: "If an account exists for that email, a password reset link is on its way.",
  };
  const user = await getUserByEmail(body.email);
  if (user && user.is_active && user.hashed_password) {
    try {
      const token = await createSetPasswordToken(user.id, user.hashed_password);
      await sendPasswordResetEmail({
        toEmail: user.email,
        fullName: user.full_name,
        token,
      });
    } catch (err) {
      // Never surface delivery/token errors to the caller — that would leak
      // whether the address exists and how the backend behaves.
      console.warn("password reset email failed:", err.message);
    }
  }
  return generic;
}

// Redeem a scoped set-password token (from the verification email). Single-use:
// the embedded fingerprint must still match the current password hash.
async function setPassword({ body }) {
  const invalid = new HttpError(401, "Invalid or expired set-password token");
  let payload;
  try {
    payload = await decodeToken(body.token);
  } catch {
    throw invalid;
  }
  if (payload.purpose !== SET_PASSWORD_PURPOSE || !payload.sub) throw invalid;

  const user = await getUser(payload.sub);
  if (!user || !user.is_active) throw invalid;
  if (payload.pwfp !== passwordFingerprint(user.hashed_password)) throw invalid;

  user.hashed_password = hashPassword(body.new_password);
  await putUser(user);
  return tokenResponse(
    await createAccessToken(user.id),
    await createRefreshToken(user.id)
  );
}

async function me({ user }) {
  // footage_enabled tells the client whether live Nx footage can be pulled for
  // this user's organization — i.e. the org is whitelisted in the Secrets
  // Manager Nx credentials (per-org nxCredentials, or nxSharedCredentials.orgIds).
  // getOrgNxCredentials performs exactly that cross-reference. The client ANDs
  // this with its Camera Connection (Tailscale funnel) toggle.
  const footageEnabled = (await getOrgNxCredentials(user.organization_id)) !== null;
  // Surface the org's operator-direct-resolve policy so the client can show the
  // right decision UI to operators (GET /settings is site_admin-only).
  const org = user.organization_id ? await getOrganization(user.organization_id) : null;
  return {
    ...userResponse(user),
    footage_enabled: footageEnabled,
    allow_operator_direct_resolve: !!(org && org.allow_operator_direct_resolve),
  };
}

export const handler = createRouter({
  "POST /api/v1/auth/login": { fn: login, schema: loginSchema },
  "POST /api/v1/auth/refresh": { fn: refresh, schema: refreshSchema },
  "POST /api/v1/auth/forgot-password": { fn: forgotPassword, schema: forgotPasswordSchema },
  "POST /api/v1/auth/set-password": { fn: setPassword, schema: setPasswordSchema },
  "GET /api/v1/auth/me": { fn: me, auth: "user" },
});
