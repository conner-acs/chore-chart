import { S3Client } from "@aws-sdk/client-s3";

// A single shared S3 client, reused across warm Lambda invocations. The footage
// bucket holds archived clips (Glacier Deep Archive) in-region (ap-southeast-2),
// satisfying the child-footage data-residency requirement.
export const s3 = new S3Client({});

export const FOOTAGE_BUCKET =
  process.env.FOOTAGE_BUCKET || `safeday-${process.env.STAGE || "dev"}-footage`;
