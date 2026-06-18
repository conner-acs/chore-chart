import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

// A single shared DocumentClient, reused across warm Lambda invocations.
// `DYNAMODB_ENDPOINT` lets the migration script / tests point at DynamoDB Local.
const client = new DynamoDBClient(
  process.env.DYNAMODB_ENDPOINT
    ? { endpoint: process.env.DYNAMODB_ENDPOINT }
    : {}
);

export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});

// Table names are injected by serverless.yml as env vars (see provider.environment).
// Falling back to a conventional name keeps the migration script usable standalone.
const stage = process.env.STAGE || "dev";
const t = (logical, env) => process.env[env] || `safeday-${stage}-${logical}`;

export const TABLES = {
  organizations: t("organizations", "ORGANIZATIONS_TABLE"),
  sites: t("sites", "SITES_TABLE"),
  users: t("users", "USERS_TABLE"),
  userSitePermissions: t("user-site-permissions", "USER_SITE_PERMISSIONS_TABLE"),
  alerts: t("alerts", "ALERTS_TABLE"),
  footageAccessLog: t("footage-access-log", "FOOTAGE_ACCESS_LOG_TABLE"),
  deviceTokens: t("device-tokens", "DEVICE_TOKENS_TABLE"),
  connections: t("connections", "CONNECTIONS_TABLE"),
};
