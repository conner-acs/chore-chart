import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { listUserIdsForSite } from "../lib/repo/permissions.js";
import { listSuperusers } from "../lib/repo/users.js";
import { listConnectionsForUser, deleteConnection } from "../lib/repo/connections.js";

// Fan a new-alert notification out to every WebSocket connection held by users
// who can see the site (explicit permission holders + all superusers). Replaces
// app/services/push_notifications.broadcast_alert + the in-memory manager.

function client() {
  // The WebSocket API callback URL, injected by serverless.yml.
  return new ApiGatewayManagementApiClient({
    endpoint: process.env.WEBSOCKET_CALLBACK_URL,
  });
}

async function sendToConnection(api, connectionId, message) {
  try {
    await api.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(message)),
      })
    );
  } catch (err) {
    // 410 Gone — the client disconnected without a clean $disconnect. Prune it.
    if (err?.$metadata?.httpStatusCode === 410) {
      await deleteConnection(connectionId);
    } else {
      console.warn("postToConnection failed for", connectionId, err.message);
    }
  }
}

export async function broadcastAlert(alertId, siteId) {
  if (!process.env.WEBSOCKET_CALLBACK_URL) return; // WS API not wired (e.g. local)

  const message = { type: "new_alert", alert_id: alertId, site_id: siteId };

  const [permitted, supers] = await Promise.all([
    listUserIdsForSite(siteId),
    listSuperusers(),
  ]);
  const userIds = new Set([...permitted, ...supers.map((u) => u.id)]);

  const connectionLists = await Promise.all(
    [...userIds].map((uid) => listConnectionsForUser(uid))
  );
  const connectionIds = connectionLists.flat();

  const api = client();
  await Promise.all(connectionIds.map((cid) => sendToConnection(api, cid, message)));
}
