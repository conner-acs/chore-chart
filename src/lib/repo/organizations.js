import {
  GetCommand,
  PutCommand,
  ScanCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

const T = TABLES.organizations;

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
