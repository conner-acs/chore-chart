#!/usr/bin/env bash
# Fire one simulated Nx detection at the prod webhook so a fresh alert shows up
# in the frontend. Designed to run from cron - needs only the webhook secret
# (no AWS credentials). The alert_type embeds the unix timestamp at fire time so
# each alert renders with a unique, time-stamped name.
export PATH="/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"
set -euo pipefail
cd "$(dirname "$0")/.."

# Webhook secret: from the environment, or sourced from .env.webhook (gitignored).
if [ -f .env.webhook ]; then . ./.env.webhook; fi
WS="${SAFEDAY_WEBHOOK_SECRET:-}"
if [ -z "$WS" ]; then
  echo "$(date -u +%FT%TZ) ERROR: SAFEDAY_WEBHOOK_SECRET not set (create .env.webhook)" >&2
  exit 1
fi

API="${SAFEDAY_API:-https://72n9yjufvi.execute-api.ap-southeast-2.amazonaws.com}"
SITE_TOKEN="${SAFEDAY_SITE_TOKEN:-Childcare-App-Test}"
CAMERA_ID="${SAFEDAY_CAMERA_ID:-{b7e8f1a2-3c4d-5e6f-7a8b-9c0d1e2f3a4b}}"

TS=$(date +%s)                          # unix timestamp -> alert name
ISO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
ALERT_TYPE="simulated_alert_${TS}"      # matches the alert_type regex; renders as the name

resp=$(curl -s -X POST "$API/api/v1/webhooks/alert" \
  -H 'Content-Type: application/json' -H "X-Webhook-Secret: $WS" \
  -d "{\"site_token\":\"$SITE_TOKEN\",\"camera_id\":\"$CAMERA_ID\",\"alert_type\":\"$ALERT_TYPE\",\"start_timestamp\":\"$ISO\",\"end_timestamp\":\"$ISO\"}")

echo "$(date -u +%FT%TZ) fired $ALERT_TYPE -> $resp"
