#!/usr/bin/env node
// Migrate the canonical Postgres dump (db_dump/childcare_dev_dump.sql) into the
// deployed DynamoDB tables. Parses the pg_dump COPY blocks (tab-separated, \N =
// NULL), converts types, denormalises site_id/camera_id/alert_type onto the
// footage access log (the relational version joined to alerts), and BatchWrites.
//
// Usage:
//   STAGE=dev node scripts/migrate.js                 # against deployed tables
//   node scripts/migrate.js --endpoint http://localhost:8000   # DynamoDB Local
//
// Uses the default AWS profile / AWS_REGION (defaults to us-east-1).

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

process.env.AWS_REGION = process.env.AWS_REGION || "us-east-1";
const endpointArg = process.argv.indexOf("--endpoint");
if (endpointArg !== -1) process.env.DYNAMODB_ENDPOINT = process.argv[endpointArg + 1];

const { BatchWriteCommand } = await import("@aws-sdk/lib-dynamodb");
const { ddb, TABLES } = await import("../src/lib/dynamo.js");

const __dirname = dirname(fileURLToPath(import.meta.url));
const DUMP = join(__dirname, "..", "db_dump", "childcare_dev_dump.sql");

// ---- pg_dump COPY parser ------------------------------------------------
function parseCopyBlocks(sql) {
  const lines = sql.split("\n");
  const blocks = {};
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^COPY public\.(\w+) \(([^)]+)\) FROM stdin;$/);
    if (!m) continue;
    const [, table, colsRaw] = m;
    const cols = colsRaw.split(",").map((c) => c.trim());
    const rows = [];
    for (i++; i < lines.length && lines[i] !== "\\."; i++) {
      const cells = lines[i].split("\t");
      const row = {};
      cols.forEach((c, j) => {
        row[c] = cells[j] === "\\N" ? null : cells[j];
      });
      rows.push(row);
    }
    blocks[table] = rows;
  }
  return blocks;
}

// ---- type coercion ------------------------------------------------------
const bool = (v) => v === "t" || v === "true" || v === true;
const num = (v) => (v === null || v === undefined ? null : Number(v));

// "2026-06-05 19:30:00+10" / "...+10:00" -> ISO 8601 ("2026-06-05T...Z").
function pgTimestampToIso(v) {
  if (!v) return null;
  let s = v.replace(" ", "T");
  // Normalise a bare-hour offset like "+10" to "+10:00".
  s = s.replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`Unparseable timestamp: ${v}`);
  return d.toISOString();
}

// Drop null/undefined keys so DynamoDB stores a clean item.
const clean = (obj) =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null && v !== undefined));

async function batchWrite(tableName, items) {
  for (let i = 0; i < items.length; i += 25) {
    const chunk = items.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [tableName]: chunk.map((Item) => ({ PutRequest: { Item } })) },
      })
    );
  }
  console.log(`  ${tableName}: ${items.length} items`);
}

async function main() {
  const blocks = parseCopyBlocks(readFileSync(DUMP, "utf8"));
  console.log("Migrating dump -> DynamoDB (region", process.env.AWS_REGION + ")");

  // organizations
  await batchWrite(
    TABLES.organizations,
    (blocks.organizations || []).map((r) => ({ id: r.id, name: r.name }))
  );

  // sites
  await batchWrite(
    TABLES.sites,
    (blocks.sites || []).map((r) =>
      clean({
        id: r.id,
        name: r.name,
        site_token: r.site_token,
        organization_id: r.organization_id,
        nx_host: r.nx_host,
        nx_username: r.nx_username,
        nx_password_encrypted: r.nx_password_encrypted,
        nx_tls_cert: r.nx_tls_cert,
        latitude: num(r.latitude),
        longitude: num(r.longitude),
      })
    )
  );

  // users
  await batchWrite(
    TABLES.users,
    (blocks.users || []).map((r) => ({
      id: r.id,
      email: r.email,
      hashed_password: r.hashed_password,
      full_name: r.full_name,
      role: r.role,
      organization_id: r.organization_id,
      account_created: r.account_created, // "YYYY-MM-DD"
      is_active: bool(r.is_active),
    }))
  );

  // user_site_permissions (composite key user_id + site_id)
  await batchWrite(
    TABLES.userSitePermissions,
    (blocks.user_site_permissions || []).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      site_id: r.site_id,
    }))
  );

  // alerts — build a lookup for footage-log enrichment
  const alerts = (blocks.alerts || []).map((r) =>
    clean({
      id: r.id,
      site_id: r.site_id,
      camera_id: r.camera_id,
      alert_type: r.alert_type,
      start_timestamp: pgTimestampToIso(r.start_timestamp),
      end_timestamp: pgTimestampToIso(r.end_timestamp),
      nx_bookmark_id: r.nx_bookmark_id,
      status: r.status,
      decided_by: r.decided_by,
      decided_at: pgTimestampToIso(r.decided_at),
      decision_label: r.decision_label,
      created_at: pgTimestampToIso(r.created_at),
    })
  );
  await batchWrite(TABLES.alerts, alerts);
  const alertById = new Map(alerts.map((a) => [a.id, a]));

  // footage_access_log — denormalise site_id/camera_id/alert_type from the alert
  const logs = (blocks.footage_access_log || []).map((r) => {
    const alert = alertById.get(r.alert_id) || {};
    return clean({
      id: r.id,
      alert_id: r.alert_id,
      site_id: alert.site_id,
      camera_id: alert.camera_id,
      alert_type: alert.alert_type,
      user_id: r.user_id,
      user_email: r.user_email,
      user_full_name: r.user_full_name,
      action: r.action,
      accessed_at: pgTimestampToIso(r.accessed_at),
    });
  });
  await batchWrite(TABLES.footageAccessLog, logs);

  // device_tokens (currently empty, but handle it)
  await batchWrite(
    TABLES.deviceTokens,
    (blocks.device_tokens || []).map((r) => ({
      id: r.id,
      user_id: r.user_id,
      token: r.token,
      platform: r.platform,
    }))
  );

  console.log("Migration complete.");
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
