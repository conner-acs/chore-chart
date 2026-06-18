import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getSecret } from "./secrets.js";

// Token lifetimes — mirror the FastAPI settings (app/core/config.py).
const ACCESS_TOKEN_EXPIRE_MINUTES = 15;
const REFRESH_TOKEN_EXPIRE_DAYS = 30;
const SET_PASSWORD_TOKEN_EXPIRE_MINUTES = 30;
const ALGORITHM = "HS256";

export const SET_PASSWORD_PURPOSE = "set_password";

// ---- Passwords ----------------------------------------------------------
// bcrypt hashes from the Postgres dump ($2b$12$...) verify directly against
// bcryptjs, so existing users keep their passwords after migration.
export const hashPassword = (plain) => bcrypt.hashSync(plain, 12);
export const verifyPassword = (plain, hashed) => bcrypt.compareSync(plain, hashed);

// ---- Tokens -------------------------------------------------------------
async function key() {
  return getSecret("secretKey");
}

export async function createAccessToken(subject) {
  return jwt.sign({ sub: subject }, await key(), {
    algorithm: ALGORITHM,
    expiresIn: `${ACCESS_TOKEN_EXPIRE_MINUTES}m`,
  });
}

export async function createRefreshToken(subject) {
  return jwt.sign({ sub: subject, type: "refresh" }, await key(), {
    algorithm: ALGORITHM,
    expiresIn: `${REFRESH_TOKEN_EXPIRE_DAYS}d`,
  });
}

export async function decodeToken(token) {
  // Throws (JsonWebTokenError / TokenExpiredError) on invalid or expired tokens.
  return jwt.verify(token, await key(), { algorithms: [ALGORITHM] });
}

// ---- Scoped, single-use set-password token ------------------------------
// Purpose-bound JWT emailed to new users. Made single-use by embedding a
// fingerprint of the current password hash: redeeming it changes the hash,
// which invalidates the fingerprint, so the token can't be replayed.
export function passwordFingerprint(hashedPassword) {
  return crypto.createHash("sha256").update(hashedPassword).digest("hex").slice(0, 16);
}

export async function createSetPasswordToken(subject, hashedPassword) {
  return jwt.sign(
    { sub: subject, purpose: SET_PASSWORD_PURPOSE, pwfp: passwordFingerprint(hashedPassword) },
    await key(),
    { algorithm: ALGORITHM, expiresIn: `${SET_PASSWORD_TOKEN_EXPIRE_MINUTES}m` }
  );
}
