import {
  GetCommand,
  PutCommand,
  ScanCommand,
  QueryCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";
import { encodeCursor, decodeCursor, countAll } from "../pagination.js";

const T = TABLES.users;

export const getUser = async (id) =>
  (await ddb.send(new GetCommand({ TableName: T, Key: { id } }))).Item || null;

// email is unique — used for login and to enforce uniqueness. `email-index` GSI.
export const getUserByEmail = async (email) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "email-index",
      KeyConditionExpression: "email = :e",
      ExpressionAttributeValues: { ":e": email },
      Limit: 1,
    })
  );
  return Items[0] || null;
};

export const listUsersByOrg = async (organizationId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "organization_id-index",
      KeyConditionExpression: "organization_id = :org",
      ExpressionAttributeValues: { ":org": organizationId },
    })
  );
  return Items;
};

export const listAllUsers = async () => {
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: T }));
  return Items.sort((a, b) => a.full_name.localeCompare(b.full_name));
};

// One page of ALL users (Scan) - { items, cursor }.
export const listAllUsersPage = async ({ limit = 25, cursor } = {}) => {
  const { Items = [], LastEvaluatedKey } = await ddb.send(
    new ScanCommand({ TableName: T, Limit: limit, ExclusiveStartKey: decodeCursor(cursor) })
  );
  return {
    items: Items.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")),
    cursor: encodeCursor(LastEvaluatedKey),
  };
};

// One page of users in a single org (organization_id-index Query) - { items, cursor }.
export const listUsersByOrgPage = async (organizationId, { limit = 25, cursor } = {}) => {
  const { Items = [], LastEvaluatedKey } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "organization_id-index",
      KeyConditionExpression: "organization_id = :org",
      ExpressionAttributeValues: { ":org": organizationId },
      Limit: limit,
      ExclusiveStartKey: decodeCursor(cursor),
    })
  );
  return {
    items: Items.sort((a, b) => (a.full_name || "").localeCompare(b.full_name || "")),
    cursor: encodeCursor(LastEvaluatedKey),
  };
};

export const countUsers = () =>
  countAll((ExclusiveStartKey) =>
    ddb.send(new ScanCommand({ TableName: T, Select: "COUNT", ExclusiveStartKey }))
  );

// Superusers — used to fan out new-alert notifications (implicit all-site access).
export const listSuperusers = async () => {
  const { Items = [] } = await ddb.send(
    new ScanCommand({
      TableName: T,
      FilterExpression: "#r = :su AND is_active = :true",
      ExpressionAttributeNames: { "#r": "role" },
      ExpressionAttributeValues: { ":su": "superuser", ":true": true },
    })
  );
  return Items;
};

export const putUser = async (user) => {
  await ddb.send(new PutCommand({ TableName: T, Item: user }));
  return user;
};

export const deleteUser = (id) =>
  ddb.send(new DeleteCommand({ TableName: T, Key: { id } }));
