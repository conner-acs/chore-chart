// One-off backfill: point seeded alerts at the REAL Art of Logic camera so the
// operator UI resolves the camera name ("Hallway-Facing-Boardroom") instead of
// falling back to a placeholder id. Only updates rows whose camera_id is the old
// dump placeholder; every other field is left untouched. Idempotent (safe to
// re-run - matching rows shrink to zero).
//
// Usage:
//   AWS_PROFILE=417183877817_EngineerAdmin AWS_REGION=ap-southeast-2 \
//   ALERTS_TABLE=safeday-prod-alerts node scripts/fix-camera-id.mjs [--dry-run]

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const OLD = "{b7e8f1a2-3c4d-5e6f-7a8b-9c0d1e2f3a4b}";
const NEW = "{b4e846a6-a4ba-1d1d-f98e-be6460f07a25}";
const TABLE = process.env.ALERTS_TABLE || "safeday-prod-alerts";
const REGION = process.env.AWS_REGION || "ap-southeast-2";
const DRY = process.argv.includes("--dry-run");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));

let scanned = 0;
let matched = 0;
let updated = 0;
let ExclusiveStartKey;

console.log(`${DRY ? "[DRY RUN] " : ""}table=${TABLE} region=${REGION}`);
console.log(`  ${OLD}  ->  ${NEW}\n`);

do {
  const out = await ddb.send(
    new ScanCommand({
      TableName: TABLE,
      ExclusiveStartKey,
      // Only pull what we need to decide + key the update.
      ProjectionExpression: "id, camera_id",
    })
  );
  for (const item of out.Items || []) {
    scanned++;
    if (item.camera_id !== OLD) continue;
    matched++;
    if (DRY) continue;
    await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id: item.id },
        UpdateExpression: "SET camera_id = :new",
        // Guard: only overwrite if it's still the placeholder (no clobber on re-run).
        ConditionExpression: "camera_id = :old",
        ExpressionAttributeValues: { ":new": NEW, ":old": OLD },
      })
    );
    updated++;
  }
  ExclusiveStartKey = out.LastEvaluatedKey;
} while (ExclusiveStartKey);

console.log(
  `\nscanned ${scanned} alerts | matched placeholder ${matched} | ${DRY ? "would update" : "updated"} ${updated}`
);
