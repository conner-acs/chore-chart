import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  CreateSecretCommand,
} from "@aws-sdk/client-secrets-manager";

// Per-organization Nx Witness credentials, each in its OWN Secrets Manager secret
// (name = `<service>/<stage>/nx/<orgId>`). Set by a superuser on /organisations/:id.
//
// This is separate from the app secret bundle (lib/secrets.js): it needs write
// access at request time (PutSecretValue/CreateSecret), and one-secret-per-org keeps
// each org's write isolated (no whole-bundle read-modify-write, no cross-org
// contention). getOrgNxCredentials() prefers a per-org secret over the bundle.

const client = new SecretsManagerClient({});

const PREFIX = process.env.NX_ORG_SECRET_PREFIX || `safeday/${process.env.STAGE || "dev"}/nx/`;
const secretId = (orgId) => `${PREFIX}${orgId}`;

// Short TTL cache so the footage path doesn't hit Secrets Manager on every request,
// while a credential change made via the admin API is picked up within the window.
const TTL_MS = 60000;
const cache = new Map(); // orgId -> { at, creds } (creds may be null = "none")

function normalize(parsed) {
  const u = parsed && parsed.username != null ? String(parsed.username) : "";
  const p = parsed && parsed.password != null ? String(parsed.password) : "";
  return u && p ? { username: u, password: p } : null;
}

// The org's stored Nx credentials, or null if none. Coerced to strings.
export async function getOrgNxSecret(orgId) {
  if (!orgId) return null;
  if (process.env.SECRET_KEY) return null; // local-dev env bypass (no Secrets Manager)
  const hit = cache.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.creds;
  let creds = null;
  try {
    const out = await client.send(new GetSecretValueCommand({ SecretId: secretId(orgId) }));
    creds = normalize(JSON.parse(out.SecretString || "{}"));
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err; // real error surfaces
    creds = null;
  }
  cache.set(orgId, { at: Date.now(), creds });
  return creds;
}

// Create or overwrite the org's per-org Nx credential secret.
export async function putOrgNxSecret(orgId, { username, password }) {
  const creds = { username: String(username), password: String(password) };
  const SecretString = JSON.stringify(creds);
  try {
    await client.send(new PutSecretValueCommand({ SecretId: secretId(orgId), SecretString }));
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
    await client.send(new CreateSecretCommand({ Name: secretId(orgId), SecretString }));
  }
  cache.set(orgId, { at: Date.now(), creds });
}
