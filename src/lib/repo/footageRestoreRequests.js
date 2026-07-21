import { GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

// footage_restore_requests: PK `id`. A reviewer raises one to retrieve past-due
// footage when the org requires site-admin approval; a site_admin approves or
// denies it. The Requests queue lists an org's requests newest-first, so
// organization_id + requested_at back a GSI, and alert_type / camera_id /
// site_id are denormalised so the queue needs no per-row alert lookup.
const T = TABLES.footageRestoreRequests;

export const getRestoreRequest = async (id) =>
  (await ddb.send(new GetCommand({ TableName: T, Key: { id } }))).Item || null;

export const putRestoreRequest = async (req) => {
  await ddb.send(new PutCommand({ TableName: T, Item: req }));
  return req;
};

export const listRestoreRequestsByOrg = async (organizationId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "organization_id-requested_at-index",
      KeyConditionExpression: "organization_id = :o",
      ExpressionAttributeValues: { ":o": organizationId },
      ScanIndexForward: false, // newest first
    })
  );
  return Items;
};
