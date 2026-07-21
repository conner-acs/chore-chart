import {
  PutObjectCommand,
  RestoreObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

// ---- HLS delivery: private prefixes + presigned-segment manifests ----

const STAGE = process.env.STAGE || "dev";

// Short-lived TTL shared by the footage token + the presigned segment URLs.
export const FOOTAGE_TOKEN_TTL_SEC = 900; // 15 min

// HLS object prefixes (many objects: index.m3u8 + seg_*.ts). Real per-alert
// footage lives under env/org/site/alert/video; demo clips under a per-type prefix.
export const hlsPrefix = (alert, videoId) =>
  `footage/${STAGE}/${alert.organization_id ?? "_"}/${alert.site_id}/${alert.id}/${videoId}/`;

export const demoHlsPrefix = (alertType) =>
  `footage/${STAGE}/_demo/${String(alertType || "").toLowerCase()}/`;

// Fallback demo clip for alert types that have no type-specific clip uploaded
// (e.g. possibly_staff / incident). Must be one of the types the transcode tool
// uploads (see tools/transcode-demo-footage.mjs in safeday-demo), so a clip is
// guaranteed present once the demo footage has been seeded.
export const DEFAULT_DEMO_ALERT_TYPE = "child_in_no_go_zone";

// Does an HLS manifest exist under `prefix`?
export const hlsExists = async (prefix) => {
  try {
    await s3.send(
      new HeadObjectCommand({ Bucket: FOOTAGE_BUCKET, Key: prefix + "index.m3u8" })
    );
    return true;
  } catch {
    return false;
  }
};

// Read the stored index.m3u8 under `prefix`, presign every segment line (SigV4,
// in-region, short-lived), and return the rewritten manifest text. The manifest
// is never stored with absolute URLs, so no single downloadable video URL ever
// exists - hls.js loads this text as a blob and fetches presigned segments
// directly from S3 (ap-southeast-2). The presigned URLs expire with the token.
export const buildSignedManifest = async (prefix) => {
  const obj = await s3.send(
    new GetObjectCommand({ Bucket: FOOTAGE_BUCKET, Key: prefix + "index.m3u8" })
  );
  const text = await obj.Body.transformToString();
  const out = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // Non-comment, non-empty lines are segment filenames (relative) - presign them.
    if (line && !line.startsWith("#")) {
      out.push(
        await getSignedUrl(
          s3,
          new GetObjectCommand({ Bucket: FOOTAGE_BUCKET, Key: prefix + line }),
          { expiresIn: FOOTAGE_TOKEN_TTL_SEC }
        )
      );
    } else {
      out.push(raw);
    }
  }
  return out.join("\n");
};
