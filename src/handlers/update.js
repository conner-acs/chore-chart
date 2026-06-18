import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE, json, parseBody } from "../lib/db.js";

export const handler = async (event) => {
  const { id } = event.pathParameters || {};

  let payload;
  try {
    payload = parseBody(event);
  } catch {
    return json(400, { message: "Invalid JSON body" });
  }

  const sets = ["updatedAt = :updatedAt"];
  const names = {};
  const values = { ":updatedAt": new Date().toISOString() };

  if (payload.title !== undefined) {
    sets.push("#title = :title");
    names["#title"] = "title";
    values[":title"] = payload.title;
  }
  if (payload.done !== undefined) {
    sets.push("done = :done");
    values[":done"] = Boolean(payload.done);
  }

  try {
    const { Attributes } = await ddb.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { id },
        UpdateExpression: "SET " + sets.join(", "),
        ExpressionAttributeNames: Object.keys(names).length ? names : undefined,
        ExpressionAttributeValues: values,
        ConditionExpression: "attribute_exists(id)",
        ReturnValues: "ALL_NEW",
      })
    );
    return json(200, Attributes);
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(404, { message: `Todo '${id}' not found` });
    }
    throw err;
  }
};
