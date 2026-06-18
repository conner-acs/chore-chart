import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE, json } from "../lib/db.js";

export const handler = async (event) => {
  const { id } = event.pathParameters || {};
  const { Item } = await ddb.send(
    new GetCommand({ TableName: TABLE, Key: { id } })
  );

  if (!Item) return json(404, { message: `Todo '${id}' not found` });
  return json(200, Item);
};
