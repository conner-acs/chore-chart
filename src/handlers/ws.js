import { decodeToken } from "../lib/auth.js";
import { getUser } from "../lib/repo/users.js";
import {
  putConnection,
  deleteConnection,
} from "../lib/repo/connections.js";

// API Gateway WebSocket API — the serverless equivalent of the FastAPI
// /ws/notifications endpoint + in-memory WebSocketManager. Connections are
// persisted in DynamoDB so any Lambda (e.g. the webhook) can broadcast to them.

// $connect — authenticate via ?token=<JWT access token> (the Bearer header
// isn't available during the WS handshake). Reject refresh tokens / inactive
// users with 401, which API Gateway turns into a failed handshake.
export const connect = async (event) => {
  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 401, body: "Missing token" };

  let payload;
  try {
    payload = await decodeToken(token);
  } catch {
    return { statusCode: 401, body: "Invalid token" };
  }
  if (payload.type === "refresh" || !payload.sub) {
    return { statusCode: 401, body: "Invalid token" };
  }

  const user = await getUser(payload.sub);
  if (!user || !user.is_active) return { statusCode: 401, body: "Invalid token" };

  await putConnection(event.requestContext.connectionId, user.id);
  return { statusCode: 200, body: "Connected" };
};

export const disconnect = async (event) => {
  await deleteConnection(event.requestContext.connectionId);
  return { statusCode: 200, body: "Disconnected" };
};

// $default — clients aren't expected to send anything (notifications are
// server-push), so inbound frames are acknowledged and ignored.
export const defaultRoute = async () => ({ statusCode: 200, body: "ok" });
