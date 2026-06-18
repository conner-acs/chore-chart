import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import {
  createAccessToken,
  createRefreshToken,
  decodeToken,
  hashPassword,
  verifyPassword,
  passwordFingerprint,
  SET_PASSWORD_PURPOSE,
} from "../lib/auth.js";
import { getUser, getUserByEmail, putUser } from "../lib/repo/users.js";
import { tokenResponse, userResponse } from "../lib/presenters.js";
import { loginSchema, refreshSchema, setPasswordSchema } from "../schemas/index.js";

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
  return userResponse(user);
}

export const handler = createRouter({
  "POST /api/v1/auth/login": { fn: login, schema: loginSchema },
  "POST /api/v1/auth/refresh": { fn: refresh, schema: refreshSchema },
  "POST /api/v1/auth/set-password": { fn: setPassword, schema: setPasswordSchema },
  "GET /api/v1/auth/me": { fn: me, auth: "user" },
});
