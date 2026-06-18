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
