import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLE, json } from "../lib/db.js";

export const handler = async (event) => {
  const { id } = event.pathParameters || {};

  try {
    await ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { id },
        ConditionExpression: "attribute_exists(id)",
      })
    );
    return json(204, "");
  } catch (err) {
    if (err.name === "ConditionalCheckFailedException") {
      return json(404, { message: `Todo '${id}' not found` });
    }
    throw err;
  }
};
