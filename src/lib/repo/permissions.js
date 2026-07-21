import {
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

// user_site_permissions: composite key (user_id HASH, site_id RANGE).
// Querying by user is a key query; querying users for a site uses the
// `site_id-index` GSI. The original surrogate `id` is kept as an attribute.
const T = TABLES.userSitePermissions;

export const getPermission = async (userId, siteId) =>
  (await ddb.send(new GetCommand({ TableName: T, Key: { user_id: userId, site_id: siteId } })))
    .Item || null;

export const listSiteIdsForUser = async (userId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      KeyConditionExpression: "user_id = :u",
      ExpressionAttributeValues: { ":u": userId },
    })
  );
  return Items.map((i) => i.site_id);
};

export const listUserIdsForSite = async (siteId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "site_id-index",
      KeyConditionExpression: "site_id = :s",
      ExpressionAttributeValues: { ":s": siteId },
    })
  );
  return Items.map((i) => i.user_id);
};

export const putPermission = (perm) =>
  ddb.send(new PutCommand({ TableName: T, Item: perm }));

export const deletePermission = (userId, siteId) =>
  ddb.send(new DeleteCommand({ TableName: T, Key: { user_id: userId, site_id: siteId } }));

export const deleteAllForUser = async (userId) => {
  const siteIds = await listSiteIdsForUser(userId);
  await Promise.all(siteIds.map((siteId) => deletePermission(userId, siteId)));
};

export const deleteAllForSite = async (siteId) => {
  const userIds = await listUserIdsForSite(siteId);
  await Promise.all(userIds.map((userId) => deletePermission(userId, siteId)));
};
