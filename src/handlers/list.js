import { ScanCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE, json } from "../lib/db.js";

export const handler = async () => {
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: TABLE }));
  Items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json(200, { count: Items.length, items: Items });
};
