import { randomUUID } from "crypto";
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE, json, parseBody } from "../lib/db.js";

export const handler = async (event) => {
  let payload;
  try {
    payload = parseBody(event);
  } catch {
    return json(400, { message: "Invalid JSON body" });
  }

  if (!payload.title || typeof payload.title !== "string") {
    return json(400, { message: "'title' is required" });
  }

  const now = new Date().toISOString();
  const todo = {
    id: randomUUID(),
    title: payload.title,
    done: Boolean(payload.done) || false,
    createdAt: now,
    updatedAt: now,
  };

  await ddb.send(new PutCommand({ TableName: TABLE, Item: todo }));
  return json(201, todo);
};
