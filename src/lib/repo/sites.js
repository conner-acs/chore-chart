import {
  GetCommand,
  PutCommand,
  ScanCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

const T = TABLES.sites;

export const getSite = async (id) =>
  (await ddb.send(new GetCommand({ TableName: T, Key: { id } }))).Item || null;

// site_token is unique — used by the webhook to resolve a site, and to enforce
// uniqueness on create. Backed by the `site_token-index` GSI.
export const getSiteByToken = async (siteToken) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "site_token-index",
      KeyConditionExpression: "site_token = :tok",
      ExpressionAttributeValues: { ":tok": siteToken },
      Limit: 1,
    })
  );
  return Items[0] || null;
};

export const listSitesByOrg = async (organizationId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "organization_id-index",
      KeyConditionExpression: "organization_id = :org",
      ExpressionAttributeValues: { ":org": organizationId },
    })
  );
  return Items.sort((a, b) => a.name.localeCompare(b.name));
};

export const listAllSites = async () => {
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: T }));
  return Items.sort((a, b) => a.name.localeCompare(b.name));
};

export const getSitesByIds = async (ids) => {
  const sites = await Promise.all(ids.map((id) => getSite(id)));
  return sites.filter(Boolean);
};

export const putSite = async (site) => {
  await ddb.send(new PutCommand({ TableName: T, Item: site }));
  return site;
};

export const deleteSite = (id) =>
  ddb.send(new DeleteCommand({ TableName: T, Key: { id } }));
