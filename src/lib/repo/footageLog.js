import { PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

// footage_access_log: PK `id`. The audit-log endpoint lists by site, newest
// first, so site_id is denormalised onto each record (the relational version
// joined log -> alert to get it). camera_id and alert_type are denormalised
// too, so the audit response needs no per-row alert lookup.
const T = TABLES.footageAccessLog;

export const putFootageLog = (entry) =>
  ddb.send(new PutCommand({ TableName: T, Item: entry }));

export const listLogsBySite = async (siteId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "site_id-accessed_at-index",
      KeyConditionExpression: "site_id = :s",
      ExpressionAttributeValues: { ":s": siteId },
      ScanIndexForward: false, // newest first
    })
  );
  return Items;
};
