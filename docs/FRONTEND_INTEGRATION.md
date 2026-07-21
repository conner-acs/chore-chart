# SafeDay frontend → serverless backend integration

This is the integration brief for pointing the SafeDay demo frontend at the new
**serverless** backend (AWS Lambda + API Gateway + DynamoDB). It replaces the
old FastAPI server that ran on `http://localhost:8080`.

**The REST contract is unchanged** — same `/api/v1/...` paths, same request and
response JSON, same `Bearer` JWT auth, same `{"detail": "..."}` error shape and
HTTP status codes. For most of the app, integration is a **base-URL swap**. The
three things that genuinely changed are called out under "What's different".

## Endpoints (deployed, us-east-1, stage `dev`)

| Purpose | Value |
| --- | --- |
| REST API base | `https://dry4ag5vo8.execute-api.us-east-1.amazonaws.com` |
| WebSocket (real-time alerts) | `wss://vqbzyfu6ii.execute-api.us-east-1.amazonaws.com/dev` |
| Footage (MP4 stream) | `https://rcgdng4hs3as4icwul43yp5waq0qucyb.lambda-url.us-east-1.on.aws` |

Put these in the frontend's environment config, e.g.:

```env
VITE_API_BASE_URL=https://dry4ag5vo8.execute-api.us-east-1.amazonaws.com
VITE_WS_URL=wss://vqbzyfu6ii.execute-api.us-east-1.amazonaws.com/dev
VITE_FOOTAGE_BASE_URL=https://rcgdng4hs3as4icwul43yp5waq0qucyb.lambda-url.us-east-1.on.aws
```

> These are the `dev` stack outputs. If the backend is redeployed to another
> stage/region the IDs change — read them from `serverless deploy` output or the
> `safeday-<stage>` CloudFormation stack outputs (`HttpApiUrl`,
> `ServiceEndpointWebsocket`, `FootageLambdaFunctionUrl`).

## Auth (unchanged)

1. `POST /api/v1/auth/login` with `{ "email", "password" }` →
   `{ "access_token", "refresh_token", "token_type": "bearer" }`.
2. Send `Authorization: Bearer <access_token>` on every protected request.
3. Access tokens expire in 15 min — on a `401` with `{"detail":"Invalid or expired token"}`,
   call `POST /api/v1/auth/refresh` with `{ "refresh_token" }` to get a new pair;
   if that also fails, send the user back to login.
4. New-user invite flow is unchanged: `POST /api/v1/auth/set-password` with
   `{ "token", "new_password" }` (token comes from the emailed link).

`GET /api/v1/auth/me` returns the current user
(`id, email, full_name, role, organization_id, account_created, is_active`).
`role` is one of `operator | site_admin | superuser` — drive role-based UI off this.

## Full endpoint map (paths identical to the old backend)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/auth/login` `/refresh` `/set-password` | public | token bodies |
| GET | `/api/v1/auth/me` | user | |
| GET | `/api/v1/alerts?status=&site_id=&limit=&offset=` | user | scoped to accessible sites |
| GET | `/api/v1/alerts/{id}` | user | |
| POST | `/api/v1/alerts/{id}/decision` | user | `{ "status": "discarded\|submitted_for_review\|incident", "decision_label?": "" }` |
| GET | `/api/v1/sites?scope=permitted\|organization` | user | `organization` = map view |
| GET/POST | `/api/v1/sites/{id}/users` | site_admin | POST body `{ "email" }` |
| DELETE | `/api/v1/sites/{id}/users/{user_id}` | site_admin | 204 |
| GET | `/api/v1/sites/{id}/audit-log?user_id=&limit=&offset=` | site_admin | |
| GET/POST/DELETE | `/api/v1/admin/organizations[/{id}]` | superuser | |
| GET/POST | `/api/v1/admin/sites` · `/admin/organizations/{id}/sites` | superuser | |
| POST | `/api/v1/admin/sites/{id}/test-connection` | superuser | Nx — see limitations |
| GET | `/api/v1/admin/sites/{id}/cameras` | superuser | Nx — see limitations |
| DELETE | `/api/v1/admin/sites/{id}` | superuser | 204 |
| GET/POST/PUT/DELETE | `/api/v1/admin/users[...]` | superuser* | PUT is partial-update; `*` PUT allows self-edits |
| POST | `/api/v1/admin/users/{id}/resend-invite` | superuser | 202 |

## What's different (the only real changes)

### 1. Footage is on a separate URL (and needs auth in JS, not a plain `<video src>`)

The old footage route was `GET /api/v1/footage/{alert_id}` on the same origin.
It's now a **Lambda Function URL with response streaming** at a different host:

```
GET {VITE_FOOTAGE_BASE_URL}/footage/{alert_id}
Authorization: Bearer <access_token>
```

Because it requires the `Authorization` header, you **cannot** point a bare
`<video src="...">` at it. Fetch it in JS and feed a blob/object URL:

```js
const res = await fetch(`${FOOTAGE_BASE_URL}/footage/${alertId}`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!res.ok) throw new Error((await res.json()).detail);   // 403/404/502 -> {"detail"}
videoEl.src = URL.createObjectURL(await res.blob());
```

> If you'd rather stream straight into `<video>`, ask the backend to add
> query-param token support (`?token=`) on the footage handler — easy to add.

### 2. Real-time notifications: WebSocket connect URL changed

Old: `ws://localhost:8080/ws/notifications?token=<jwt>`.
New: connect to the WebSocket API stage root with the token as a query param:

```js
const ws = new WebSocket(`${WS_URL}?token=${accessToken}`);
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);   // { type: "new_alert", alert_id, site_id }
  if (msg.type === "new_alert") { /* refetch /alerts or insert */ }
};
```

The message payload is identical to before (`{ type, alert_id, site_id }`).
Auth/refresh tokens and inactive users are rejected at connect (the socket just
won't open). The server only pushes; the client doesn't need to send anything.
On a `1006`/close, reconnect with a fresh access token.

### 3. Validation error body is a string, not FastAPI's array

FastAPI returned `422` with `{"detail":[{"loc":...,"msg":...}]}`. This backend
returns `422` with **`{"detail":"message1; message2"}`** (a plain string), same
as every other error. If any frontend code reads `detail[0].msg`, switch it to
treat `detail` as a string. All other errors (`401/403/404/409/502`) were already
`{"detail":"string"}` and are unchanged.

## CORS

CORS is enabled on the API (all origins, standard methods/headers), and the
footage Function URL has CORS enabled too. Auth is via the `Authorization`
header (no cookies), so no `credentials: 'include'` is needed.

## Known limitations to handle gracefully in the UI

- **Nx Witness calls return 502** in the demo: `test-connection`, `cameras`, and
  `footage` reach per-site VMS servers on private IPs (`192.168.x`) that are
  unreachable from AWS. Expect `502 {"detail":"Could not reach..."}` and show a
  friendly "camera/footage unavailable" state rather than a hard error.
- **Set-password email links** point at `PUBLIC_BASE_URL` (currently
  `http://localhost:3000`). If the demo site is hosted elsewhere, ask the backend
  to set `PUBLIC_BASE_URL` to the demo origin and redeploy, so invite links land
  on the right host.

## Suggested integration steps

1. Add the three URLs to the frontend env config; replace the hardcoded
   `localhost:8080` base.
2. Verify login → `me` → `alerts` works end to end (data is already migrated:
   try a known user, or the seeded accounts).
3. Repoint the footage player to `VITE_FOOTAGE_BASE_URL` and switch to the
   fetch→blob pattern (handle 502).
4. Repoint the WebSocket to `VITE_WS_URL?token=` and confirm a `new_alert` push
   refreshes the list (trigger one via `POST /api/v1/webhooks/alert` with the
   `X-Webhook-Secret` header, or have the backend team fire one).
5. Make sure any `422` handling reads `detail` as a string.
6. Smoke-test role-gated screens with an `operator`, `site_admin`, and
   `superuser` account.
