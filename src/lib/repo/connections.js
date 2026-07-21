import { PutCommand, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { ddb, TABLES } from "../dynamo.js";

// WebSocket connections: PK `connectionId`, indexed by user via `user_id-index`.
// One user may hold several connections (multiple tabs/devices); a broadcast
// fans out to all of them. Replaces the in-memory WebSocketManager.
const T = TABLES.connections;

export const putConnection = (connectionId, userId) =>
  ddb.send(
    new PutCommand({
      TableName: T,
      Item: { connectionId, user_id: userId, connected_at: new Date().toISOString() },
    })
  );

export const deleteConnection = (connectionId) =>
  ddb.send(new DeleteCommand({ TableName: T, Key: { connectionId } }));

export const listConnectionsForUser = async (userId) => {
  const { Items = [] } = await ddb.send(
    new QueryCommand({
      TableName: T,
      IndexName: "user_id-index",
      KeyConditionExpression: "user_id = :u",
      ExpressionAttributeValues: { ":u": userId },
    })
  );
  return Items.map((i) => i.connectionId);
};
