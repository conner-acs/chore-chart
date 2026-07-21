# safeday-serverless

The **SafeDay childcare alert-triage backend**, transposed from a FastAPI +
SQLAlchemy + Postgres app (originally on port 8080) into the **Serverless
Framework** — AWS **Lambda + API Gateway + DynamoDB**, with request validation
in **Joi** and secrets in **AWS Secrets Manager**. It's a drop-in replacement
for the REST contract the existing frontend/Flutter app already speaks, so the
demo site can point at it in production.

## Architecture

```
                         ┌──────────────── API Gateway (HTTP API) ───────────────┐
  Frontend / Flutter ───▶│  /api/v1/auth  /alerts  /sites  /admin  /webhooks      │──┐
                         └────────────────────────────────────────────────────────┘  │
                         ┌──────────── API Gateway (WebSocket API) ──────────────┐    │  Lambda
  Desktop (real-time) ──▶│  $connect / $disconnect / $default  (?token=<JWT>)     │──┼─▶ (Node 20)
                         └────────────────────────────────────────────────────────┘    │   │
                         ┌──────────── Lambda Function URL (stream) ─────────────┐     │   ▼
  Footage (MP4) ────────▶│  GET /footage/{alert_id}  RESPONSE_STREAM             │─────┘  DynamoDB
                         └────────────────────────────────────────────────────────┘        (8 tables)
                                                                                   Secrets Manager
```

- **REST** — 5 router Lambdas (`auth`, `alerts`, `sites`, `admin`, `webhooks`),
  each dispatching internally on the API Gateway `routeKey`. ~25 endpoints,
  identical paths/shapes to the FastAPI app (`/api/v1/...`).
- **WebSocket API** — replaces the FastAPI `/ws/notifications` socket + in-memory
  connection manager. Connections are stored in DynamoDB so the webhook Lambda
  can broadcast new-alert events via the API Gateway Management API.
- **Footage** — a Lambda **Function URL with response streaming**
  (`RESPONSE_STREAM`), which bypasses API Gateway's 10 MB / 29 s limits and
  streams the Nx Witness MP4 to the client in chunks.
- **Auth** — JWT (HS256) access/refresh tokens + the single-use, fingerprinted
  set-password token, bcrypt password hashing (existing `$2b$` hashes from the
  dump verify as-is), role + per-site permission checks.
- **Validation** — every request body is validated/coerced with Joi (422 on
  failure, mirroring FastAPI).
- **Data** — DynamoDB, one table per entity, with GSIs for every access pattern
  (see `serverless.yml`). `alembic_version` is dropped (migration bookkeeping).

## Prerequisites

- Node.js 18+ and the AWS CLI configured with a **`default`** profile.
- Serverless Framework v4 needs a free login/license key — run
  `npx serverless login` once (or set `SERVERLESS_ACCESS_KEY`).

## Deploy

```bash
npm install
npm run deploy            # serverless deploy --stage dev --region us-east-1
```

The deploy creates the DynamoDB tables, both APIs, the footage Function URL,
and a **stub** Secrets Manager secret. It prints the REST base URL
(`HttpApiUrl`), the WebSocket URL (`WebSocketUrl`), and the footage Function URL.

## Secrets — what to set & how

The app loads a single JSON secret named **`safeday/dev/app`** at cold start
(one secret, one fetch, one IAM grant). `serverless deploy` creates it with
placeholder `REPLACE_ME` values, so **you must populate the real values once
after the first deploy** or auth/webhooks will fail.

| Key in the JSON          | What it is                                          | Required |
| ------------------------ | --------------------------------------------------- | -------- |
| `secretKey`              | JWT signing key (HS256). Any high-entropy string.   | ✅       |
| `nxCredentialEncryptionKey` | Fernet key that decrypts each site's stored Nx Witness password. **Must** be the same key used to encrypt them. | ✅ |
| `webhookSecret`          | Shared secret checked on `POST /webhooks/alert` (`X-Webhook-Secret` header). | ✅ |
| `mailtrapApiToken`       | Mailtrap API token for invite emails. Leave `""` to disable email (no-op). | ⬜ optional |

Generate fresh values if you're starting clean:

```bash
# JWT key + webhook secret (32 random bytes, hex)
openssl rand -hex 32
# Fernet key (urlsafe base64, 32 bytes) — must match how Nx passwords were encrypted
python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
```

### Tutorial: add the secrets

**Option A — AWS CLI (recommended)**

```bash
aws secretsmanager put-secret-value \
  --profile default --region us-east-1 \
  --secret-id safeday/dev/app \
  --secret-string '{
    "secretKey":"<your-jwt-key>",
    "nxCredentialEncryptionKey":"<your-fernet-key>",
    "webhookSecret":"<your-webhook-secret>",
    "mailtrapApiToken":""
  }'
```

**Option B — AWS Console**

1. Open **AWS Console → Secrets Manager → Secrets**.
2. Click **`safeday/dev/app`**.
3. **Retrieve secret value → Edit**, switch to **Plaintext**, paste the JSON
   above with your real values, and **Save**.

Secrets are cached per Lambda cold start. After updating, either wait a minute
or redeploy (`npm run deploy`) to force fresh containers. CloudFormation will
**not** clobber your values on future deploys (the template's `SecretString`
stays as the placeholder, so CFN sees no change).

> **Local dev shortcut:** export `SECRET_KEY`, `NX_CREDENTIAL_ENCRYPTION_KEY`,
> `WEBHOOK_SECRET`, `MAILTRAP_API_TOKEN` as env vars and the app reads those
> instead of calling Secrets Manager (see `src/lib/secrets.js`).

## Migrate the database (Postgres dump → DynamoDB)

The canonical dump lives in [`db_dump/`](db_dump/) (`childcare_dev_dump.sql`,
plus per-table JSON Schemas). After deploying and setting secrets:

```bash
STAGE=dev npm run migrate
```

This parses the `pg_dump` COPY blocks, converts types (uuid/text passthrough,
timestamps → ISO 8601, booleans, numbers), denormalises `site_id` / `camera_id`
/ `alert_type` onto the footage access log (the relational version got these via
a join), and `BatchWrite`s every table. Idempotent — re-running overwrites by
primary key.

## Try it

```bash
API=$(aws cloudformation describe-stacks --stack-name safeday-dev \
  --query "Stacks[0].Outputs[?OutputKey=='HttpApiUrl'].OutputValue" \
  --output text --profile default --region us-east-1)

# Log in (migrated user — superuser)
curl -s -X POST $API/api/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"admin@example.com","password":"<password>"}'

# Use the returned access_token
TOKEN=...
curl -s $API/api/v1/auth/me      -H "Authorization: Bearer $TOKEN"
curl -s $API/api/v1/alerts       -H "Authorization: Bearer $TOKEN"
curl -s "$API/api/v1/sites?scope=organization" -H "Authorization: Bearer $TOKEN"
```

`./test.sh` runs a full end-to-end smoke test (login → list → decision → audit
log) against the deployed API.

## Endpoint map (parity with the FastAPI app)

| Method | Path | Function |
| --- | --- | --- |
| POST | `/api/v1/auth/login` `/refresh` `/set-password` · GET `/me` | `auth` |
| GET | `/api/v1/alerts` · GET `/{id}` · POST `/{id}/decision` | `alerts` |
| GET/POST/DELETE | `/api/v1/sites` · `/{id}/users` · `/{id}/audit-log` | `sites` |
| (15 routes) | `/api/v1/admin/organizations\|sites\|users...` | `admin` |
| POST | `/api/v1/webhooks/alert` (`X-Webhook-Secret`) | `webhooks` |
| GET | `/footage/{alert_id}` (Function URL, streamed MP4) | `footage` |
| WS | `$connect` `$disconnect` `$default` (`?token=`) | `wsConnect/...` |

## Known limitations & production notes

- **Nx Witness reachability** — sites point at private VMS hosts
  (`192.168.x:7001`). Those are unreachable from AWS, so `test-connection`,
  `cameras`, and `footage` return **502** until there's VPC connectivity
  (VPN / Direct Connect) into each centre's network. The Fernet decrypt path
  still runs (credentials round-trip correctly); only the network call fails.
- **Footage at scale** — the streaming Function URL handles single/short clips
  well. For sustained, highly concurrent, long video exports, evolve the footage
  path to **ECS Fargate** behind the VPC tunnel (keep the rest serverless).
- **Mobile push** — the `device_tokens` table and FCM/APNs path are stubbed
  (as in the original). That's where **SNS mobile push** (or FCM) plugs in
  later; it does not affect the desktop WebSocket path.

## Tear down

```bash
npm run remove
```
