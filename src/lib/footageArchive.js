import {
  PutObjectCommand,
  RestoreObjectCommand,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { s3, FOOTAGE_BUCKET } from "./s3.js";

// Footage lifecycle states carried on an alert (default "hot" when absent):
//   hot       - not archived; served live from Nx as today
//   archived  - moved to Glacier Deep Archive; must be restored before viewing
//   restoring - a Glacier restore is in progress (12-48h for Deep Archive)
//   restored  - temporarily available again from S3
export const FOOTAGE_STATES = ["hot", "archived", "restoring", "restored"];

// S3 key for an alert's footage. alert_id is embedded so a status poll (or a
// future restore-complete event) can map an object back to its alert.
export const footageKey = (alert) =>
  `footage/${alert.site_id}/${alert.id}/clip.dat`;

// Placeholder mode: write a small marker object straight into Deep Archive.
// Real Nx clip capture will later write the actual footage to this key BEFORE
// the archiver runs; the archive/restore mechanics below are identical either
// way, so the pipeline is testable now and swaps to real footage transparently.
export const archivePlaceholder = async (alert) => {
  const key = footageKey(alert);
  const body = JSON.stringify({
    placeholder: true,
    note: "Nx clip capture pending; this marks the archived footage slot.",
    alert_id: alert.id,
    site_id: alert.site_id,
    camera_id: alert.camera_id,
    start_timestamp: alert.start_timestamp,
    end_timestamp: alert.end_timestamp,
  });
  await s3.send(
    new PutObjectCommand({
      Bucket: FOOTAGE_BUCKET,
      Key: key,
      Body: body,
      ContentType: "application/json",
      StorageClass: "DEEP_ARCHIVE",
    })
  );
  return key;
};

// Kick off a Deep Archive restore. Deep Archive supports Standard (~12h) and
// Bulk (~48h, cheapest) retrieval tiers; Bulk matches the cost-first choice.
// The restored copy lives for `days` before S3 drops it (Glacier-only again).
export const initiateRestore = async (key, days = 7) => {
  await s3.send(
    new RestoreObjectCommand({
      Bucket: FOOTAGE_BUCKET,
      Key: key,
      RestoreRequest: { Days: days, GlacierJobParameters: { Tier: "Bulk" } },
    })
  );
};

// Has the restore finished? HeadObject's Restore header reads
// 'ongoing-request="false", expiry-date="..."' once the temporary copy is ready.
export const isRestoreComplete = async (key) => {
  const head = await s3.send(
    new HeadObjectCommand({ Bucket: FOOTAGE_BUCKET, Key: key })
  );
  return /ongoing-request="false"/.test(head.Restore || "");
};
