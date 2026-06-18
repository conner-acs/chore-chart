import { QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

// device_tokens: PK `id`, queried by user via the `user_id-index` GSI.
// (Currently 0 rows; the FCM/mobile-push path is documented as future work.)
const T = TABLES.deviceTokens;

export const listTokensForUser = async (userId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "user_id-index",
      KeyConditionExpression: "user_id = :u",
      ExpressionAttributeValues: { ":u": userId },
    })
  );
  return Items;
};

export const deleteAllForUser = async (userId) => {
  const tokens = await listTokensForUser(userId);
  await Promise.all(
    tokens.map((t) => ddb.send(new DeleteCommand({ TableName: T, Key: { id: t.id } })))
  );
};
