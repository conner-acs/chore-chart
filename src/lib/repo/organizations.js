import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

const T = TABLES.organizations;

// Atomically adjust the org's count of footage currently in deep archive
// (+1 when the archiver stores a clip, -1 when a restore completes).
export const incrementArchivedCount = (organizationId, delta = 1) =>
  ddb.send(
    new UpdateCommand({
      TableName: T,
      Key: { id: organizationId },
      UpdateExpression: "ADD archived_footage_count :d",
      ExpressionAttributeValues: { ":d": delta },
    })
  );

export const decrementArchivedCount = (organizationId) =>
  incrementArchivedCount(organizationId, -1);

export const getOrganization = async (id) =>
  (await ddb.send(new GetCommand({ TableName: T, Key: { id } }))).Item || null;

export const listOrganizations = async () => {
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: T }));
  return Items.sort((a, b) => a.name.localeCompare(b.name));
};

export const putOrganization = async (org) => {
  await ddb.send(new PutCommand({ TableName: T, Item: org }));
  return org;
};

export const deleteOrganization = (id) =>
  ddb.send(new DeleteCommand({ TableName: T, Key: { id } }));
