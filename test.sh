#!/usr/bin/env bash
# End-to-end smoke test for the deployed safeday API.
# Exercises auth, alerts, sites, admin, the webhook, a decision, and the audit log.
#
# Auth: if SAFEDAY_EMAIL + SAFEDAY_PASSWORD are set, it logs in normally.
# Otherwise it mints an access token locally with SAFEDAY_JWT_SECRET (the dump's
# migrated users have no known plaintext password), signing for SAFEDAY_USER_ID.
set -euo pipefail
cd "$(dirname "$0")"

# Config is pulled from the environment. Copy .env.test.example -> .env.test and
# fill in your values (credentials, deployed URL, secrets); .env.test is
# gitignored so nothing sensitive is committed. The file provides DEFAULTS only —
# an explicitly-exported variable always wins, so you can override inline:
#   WEBHOOK_SECRET=REPLACE_ME SAFEDAY_EMAIL=you@... ./test.sh
if [ -f .env.test ]; then
  while IFS='=' read -r k v; do
    case "$k" in '' | '#'*) continue ;; esac          # skip blanks/comments
    [ -z "${!k:-}" ] && export "$k=$v"                 # don't clobber a set var
  done < .env.test
fi

API="${API:-https://dry4ag5vo8.execute-api.us-east-1.amazonaws.com}"
API="${API%/}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-REPLACE_ME}"          # matches the Secrets Manager stub
JWT_SECRET="${SAFEDAY_JWT_SECRET:-REPLACE_ME}"          # matches the Secrets Manager stub
USER_ID="${SAFEDAY_USER_ID:-d53f5b70-0a39-4c72-9af6-cdde6941b8cd}"  # migrated superuser
SITE_TOKEN="${SAFEDAY_SITE_TOKEN:-acs-child-centre}"
# Default kept on its own line — a brace-wrapped UUID inside a ${:-default}
# expansion would have its own '}' close the expansion early.
CAMERA_ID="{b7e8f1a2-3c4d-5e6f-7a8b-9c0d1e2f3a4b}"
[ -n "${SAFEDAY_CAMERA_ID:-}" ] && CAMERA_ID="$SAFEDAY_CAMERA_ID"
SAFEDAY_EMAIL="${SAFEDAY_EMAIL:-}"
SAFEDAY_PASSWORD="${SAFEDAY_PASSWORD:-}"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
echo "Testing API: $API"

# ---- obtain a token ----
if [ -n "${SAFEDAY_EMAIL:-}" ] && [ -n "${SAFEDAY_PASSWORD:-}" ]; then
  echo "[auth] logging in as $SAFEDAY_EMAIL"
  TOKEN=$(curl -s -X POST "$API/api/v1/auth/login" -H 'Content-Type: application/json' \
    -d "{\"email\":\"$SAFEDAY_EMAIL\",\"password\":\"$SAFEDAY_PASSWORD\"}" | jq -r '.access_token')
else
  echo "[auth] minting token for superuser $USER_ID"
  TOKEN=$(node -e "console.log(require('jsonwebtoken').sign({sub:process.argv[1]},process.argv[2],{algorithm:'HS256',expiresIn:'15m'}))" "$USER_ID" "$JWT_SECRET")
fi
[ -n "$TOKEN" ] && [ "$TOKEN" != "null" ] || fail "no token"
AUTH="Authorization: Bearer $TOKEN"
pass "token acquired"

echo "[1] GET /auth/me"
me=$(curl -s "$API/api/v1/auth/me" -H "$AUTH")
ROLE=$(echo "$me" | jq -r '.role')
USER_ID=$(echo "$me" | jq -r '.id')   # trust the server's identity over any default
[ -n "$ROLE" ] && [ "$ROLE" != "null" ] || fail "me lookup failed, got: $me"
pass "me: $(echo "$me" | jq -r '.email') ($ROLE)"

if [ "$ROLE" = "superuser" ]; then
  echo "[2] GET /admin/users (superuser-only)"
  n=$(curl -s "$API/api/v1/admin/users" -H "$AUTH" | jq 'length')
  [ "$n" -gt 0 ] 2>/dev/null || fail "expected users"
  pass "$n users"

  echo "[3] GET /admin/sites"
  ns=$(curl -s "$API/api/v1/admin/sites" -H "$AUTH" | jq 'length')
  [ "$ns" -gt 0 ] 2>/dev/null || fail "expected sites"
  pass "$ns sites"
else
  echo "[2-3] admin endpoints — skipped (logged-in role '$ROLE' is not superuser)"
  echo "      verifying admin route is forbidden for this role"
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/admin/users" -H "$AUTH")
  [ "$code" = "403" ] || fail "expected 403 on /admin/users for $ROLE, got $code"
  pass "admin route correctly forbidden (403)"
fi

echo "[4] POST /webhooks/alert (X-Webhook-Secret)"
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
created=$(curl -s -X POST "$API/api/v1/webhooks/alert" \
  -H 'Content-Type: application/json' -H "X-Webhook-Secret: $WEBHOOK_SECRET" \
  -d "{\"site_token\":\"$SITE_TOKEN\",\"camera_id\":\"$CAMERA_ID\",\"alert_type\":\"child_alone\",\"start_timestamp\":\"$now\",\"end_timestamp\":\"$now\"}")
ALERT_ID=$(echo "$created" | jq -r '.id')
SITE_ID=$(echo "$created" | jq -r '.site_id')
[ -n "$ALERT_ID" ] && [ "$ALERT_ID" != "null" ] || fail "webhook did not create alert: $created"
[ "$(echo "$created" | jq -r '.status')" = "unprocessed" ] || fail "new alert not unprocessed"
pass "alert created id=$ALERT_ID status=unprocessed"

echo "[5] GET /alerts (list, scoped)"
curl -s "$API/api/v1/alerts" -H "$AUTH" | jq -e --arg id "$ALERT_ID" 'any(.[]; .id == $id)' >/dev/null \
  || fail "new alert not in list"
pass "alert present in list"

echo "[6] GET /alerts/{id}"
[ "$(curl -s "$API/api/v1/alerts/$ALERT_ID" -H "$AUTH" | jq -r '.id')" = "$ALERT_ID" ] || fail "get alert mismatch"
pass "fetched single alert"

echo "[7] POST /alerts/{id}/decision (discard)"
dec=$(curl -s -X POST "$API/api/v1/alerts/$ALERT_ID/decision" -H "$AUTH" \
  -H 'Content-Type: application/json' -d '{"status":"discarded","decision_label":"false_alarm"}')
[ "$(echo "$dec" | jq -r '.status')" = "discarded" ] || fail "decision not applied: $dec"
[ "$(echo "$dec" | jq -r '.decided_by')" = "$USER_ID" ] || fail "decided_by not set"
pass "alert discarded"

echo "[8] GET /sites/{id}/audit-log (records the decision)"
curl -s "$API/api/v1/sites/$SITE_ID/audit-log" -H "$AUTH" \
  | jq -e --arg id "$ALERT_ID" 'any(.[]; .alert_id == $id and .action == "discarded")' >/dev/null \
  || fail "decision not in audit log"
pass "audit log records the discard"

echo "[9] auth rejection (no token -> 401)"
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/alerts")
[ "$code" = "401" ] || fail "expected 401, got $code"
pass "unauthenticated request rejected (401)"

echo "[10] POST /admin/test-email (fires a test email to the TEST_EMAIL_TO secret)"
if [ "$ROLE" = "superuser" ]; then
  res=$(curl -s -w '\n%{http_code}' -X POST "$API/api/v1/admin/test-email" -H "$AUTH")
  http=$(echo "$res" | tail -1); body=$(echo "$res" | sed '$d')
  [ "$http" = "200" ] || fail "test-email endpoint returned $http: $body"
  sent=$(echo "$body" | jq -r '.sent'); prov=$(echo "$body" | jq -r '.provider')
  to=$(echo "$body" | jq -r '.to // "?"'); err=$(echo "$body" | jq -r '.error // ""')
  if [ "$sent" = "true" ]; then
    pass "test email sent via $prov to $to"
  else
    # Endpoint works; delivery may be pending SES identity verification / prod access.
    pass "test-email endpoint OK (provider=$prov) — not delivered yet: ${err:-unknown}"
  fi
else
  echo "      skipped — needs superuser (logged in as '$ROLE')"
fi

printf '\n\033[32mAll checks passed.\033[0m\n'
