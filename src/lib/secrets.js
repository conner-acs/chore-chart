import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from "@aws-sdk/client-secrets-manager";

// Loads the application's secret bundle from AWS Secrets Manager once per cold
// start and caches it. The whole app's secrets live in a single JSON secret
// (name in SECRETS_ID) so there's one network round-trip and one IAM grant.
//
// For local development / the migration script you can bypass Secrets Manager
// entirely by exporting the same keys as environment variables (see resolve()).

const client = new SecretsManagerClient({});

let cache = null;

const ENV_FALLBACKS = {
  SECRET_KEY: "secretKey",
  NX_CREDENTIAL_ENCRYPTION_KEY: "nxCredentialEncryptionKey",
  WEBHOOK_SECRET: "webhookSecret",
  MAILTRAP_API_TOKEN: "mailtrapApiToken",
  TEST_EMAIL_TO: "testEmailTo",
};

async function load() {
  if (cache) return cache;

  // Env-var override: if SECRET_KEY is set locally, skip Secrets Manager.
  if (process.env.SECRET_KEY) {
    cache = {};
    for (const [env, key] of Object.entries(ENV_FALLBACKS)) {
      if (process.env[env] !== undefined) cache[key] = process.env[env];
    }
    // Per-org Nx credentials as a JSON string for local dev, e.g.
    //   NX_CREDENTIALS_JSON='{"<org_id>":{"username":"admin","password":"..."}}'
    if (process.env.NX_CREDENTIALS_JSON) {
      try {
        cache.nxCredentials = JSON.parse(process.env.NX_CREDENTIALS_JSON);
      } catch {
        /* leave unset; getOrgNxCredentials will report none configured */
      }
    }
    // One credential set whitelisted to several orgs, e.g.
    //   NX_SHARED_CREDENTIALS_JSON='{"username":"admin","password":"..","orgIds":["a","b"]}'
    if (process.env.NX_SHARED_CREDENTIALS_JSON) {
      try {
        cache.nxSharedCredentials = JSON.parse(process.env.NX_SHARED_CREDENTIALS_JSON);
      } catch {
        /* leave unset */
      }
    }
    return cache;
  }

  const secretId = process.env.SECRETS_ID;
  if (!secretId) {
    throw new Error("SECRETS_ID is not configured and no SECRET_KEY env fallback present");
  }
  const out = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  cache = JSON.parse(out.SecretString || "{}");
  return cache;
}

// Return one secret value by its key in the bundle. Throws if missing so a
// misconfigured deployment fails loudly rather than minting unsigned tokens.
export async function getSecret(key) {
  const secrets = await load();
  const value = secrets[key];
  if (value === undefined || value === null || value === "") {
    throw new Error(`Secret '${key}' is not set in ${process.env.SECRETS_ID || "env"}`);
  }
  return value;
}

// Optional secrets (e.g. Mailtrap token) — returns undefined instead of throwing.
export async function getOptionalSecret(key) {
  const secrets = await load();
  const value = secrets[key];
  return value === "" ? undefined : value;
}

// Per-organization Nx Witness credentials, resolved from the Secrets Manager
// bundle. Two sources, checked in order:
//
//   1. `nxCredentials`        - explicit per-org map:
//                               { "<org_id>": { username, password } }
//   2. `nxSharedCredentials`  - one credential set whitelisted to many orgs:
//                               { username, password, orgIds: ["<org_id>", ...] }
//
// A per-org entry always wins over the shared set, so a single org can override
// the shared credentials. Keeping the VMS username+password in Secrets Manager
// (not DynamoDB) means the footage path resolves them at request time and they
// never live in the data store. Returns null when the org matches neither, so
// the caller surfaces a clean 502 rather than crashing.
// Coerce to strings so a mis-typed secret value (e.g. a password written as a
// bare JSON number → the Nx login body carries `"password":<number>`, which Nx
// rejects with a 400) can't corrupt the request. Returns null unless BOTH are
// non-empty strings, so the caller still surfaces a clean 502 for missing creds.
function normalizeCreds(username, password) {
  const u = username == null ? "" : String(username);
  const p = password == null ? "" : String(password);
  return u && p ? { username: u, password: p } : null;
}

export async function getOrgNxCredentials(organizationId) {
  const secrets = await load();

  const explicit = (secrets.nxCredentials || {})[organizationId];
  if (explicit) {
    const creds = normalizeCreds(explicit.username, explicit.password);
    if (creds) return creds;
  }

  const shared = secrets.nxSharedCredentials;
  if (shared && Array.isArray(shared.orgIds) && shared.orgIds.includes(organizationId)) {
    const creds = normalizeCreds(shared.username, shared.password);
    if (creds) return creds;
  }

  return null;
}
