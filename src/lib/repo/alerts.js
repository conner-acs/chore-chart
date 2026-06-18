import {
  GetCommand,
  PutCommand,
  ScanCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

// alerts: PK `id`. Listed per-site, newest-first, via the
// `site_id-created_at-index` GSI (created_at ISO strings sort chronologically).
const T = TABLES.alerts;

export const getAlert = async (id) =>
  (await ddb.send(new GetCommand({ TableName: T, Key: { id } }))).Item || null;

export const listAlertsBySite = async (siteId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "site_id-created_at-index",
      KeyConditionExpression: "site_id = :s",
      ExpressionAttributeValues: { ":s": siteId },
      ScanIndexForward: false, // newest first
    })
  );
  return Items;
};

export const listAllAlerts = async () => {
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: T }));
  return Items.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
};

export const putAlert = async (alert) => {
  await ddb.send(new PutCommand({ TableName: T, Item: alert }));
  return alert;
};

export const hasAlertsForSite = async (siteId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "site_id-created_at-index",
      KeyConditionExpression: "site_id = :s",
      ExpressionAttributeValues: { ":s": siteId },
      Limit: 1,
    })
  );
  return Items.length > 0;
};
