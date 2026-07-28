#!/usr/bin/env bash
#
# Diagnose "No footage available for this alert" and PROVE footage can be retrieved
# from AWS end-to-end (S3 + the footage-token endpoint + a presigned segment).
#
# It answers, in order:
#   1. Is the demo HLS actually in the bucket?  (did the transcode run?)
#   2. What is this alert's type / footage_hls_prefix in DynamoDB?
#   3. Does index.m3u8 exist at the key the backend will read?
#   4. Does the token endpoint return a signed manifest?  (curl)
#   5. Does a presigned segment from that manifest download?  (curl -> proves retrieval)
#
# Usage:
#   STAGE=prod REGION=ap-southeast-2 PROFILE=417183877817_EngineerAdmin \
#   API_BASE=https://<api-id>.execute-api.ap-southeast-2.amazonaws.com \
#   BEARER=<a-valid-user-JWT> ALERT_ID=<alert-id> \
#   ./scripts/verify-footage.sh
#
set -uo pipefail

STAGE="${STAGE:-prod}"
REGION="${REGION:-ap-southeast-2}"
PROFILE="${PROFILE:-417183877817_EngineerAdmin}"
BUCKET="${BUCKET:-safeday-${STAGE}-footage}"
ALERTS_TABLE="${ALERTS_TABLE:-safeday-${STAGE}-alerts}"
AWS=(aws --region "$REGION" --profile "$PROFILE")

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓ %s\033[0m\n' "$1"; }
bad() { printf '  \033[31m✗ %s\033[0m\n' "$1"; }

say "1. Demo HLS present in s3://${BUCKET}/footage/${STAGE}/_demo/"
DEMO=$("${AWS[@]}" s3 ls "s3://${BUCKET}/footage/${STAGE}/_demo/" 2>&1)
if [ -z "$DEMO" ]; then
  bad "NOTHING under _demo/ — the transcode tool has not uploaded. Run it first:"
  echo "     (from safeday-demo) node tools/transcode-demo-footage.mjs --stage ${STAGE} --region ${REGION} --profile ${PROFILE}"
else
  echo "$DEMO" | awk '{print "   "$0}'
  ok "demo prefixes above are the alert_types with a clip"
fi

if [ -z "${ALERT_ID:-}" ]; then
  say "Set ALERT_ID=<id> to check a specific alert + run the curl retrieval test."; exit 0
fi

say "2. Alert ${ALERT_ID} in ${ALERTS_TABLE}"
ITEM=$("${AWS[@]}" dynamodb get-item --table-name "$ALERTS_TABLE" \
  --key "{\"id\":{\"S\":\"${ALERT_ID}\"}}" \
  --projection-expression "alert_type, footage_hls_prefix, site_id" --output json 2>&1)
if ! echo "$ITEM" | grep -q '"Item"'; then bad "alert not found: $ITEM"; exit 1; fi
ATYPE=$(echo "$ITEM" | sed -n 's/.*"alert_type": *{ *"S": *"\([^"]*\)".*/\1/p' | head -1)
APREFIX=$(echo "$ITEM" | sed -n 's/.*"footage_hls_prefix": *{ *"S": *"\([^"]*\)".*/\1/p' | head -1)
echo "   alert_type          = ${ATYPE:-<none>}"
echo "   footage_hls_prefix  = ${APREFIX:-<none>}"

say "3. HeadObject the keys the backend will read (first hit wins)"
TYPE_LC=$(printf '%s' "$ATYPE" | tr '[:upper:]' '[:lower:]')
for KEY in \
  ${APREFIX:+"${APREFIX}index.m3u8"} \
  "footage/${STAGE}/_demo/${TYPE_LC}/index.m3u8" \
  "footage/${STAGE}/_demo/child_in_no_go_zone/index.m3u8"; do
  if "${AWS[@]}" s3api head-object --bucket "$BUCKET" --key "$KEY" >/dev/null 2>&1; then
    ok "FOUND $KEY"; RESOLVED="$KEY"; break
  else
    bad "missing $KEY"
  fi
done
[ -n "${RESOLVED:-}" ] || { bad "no manifest at any candidate key — see step 1 (transcode) / step 2 (type)"; }

if [ -z "${API_BASE:-}" ] || [ -z "${BEARER:-}" ]; then
  say "Set API_BASE=<httpApi-url> and BEARER=<user-JWT> to run the live curl test."; exit 0
fi

say "4. POST ${API_BASE}/api/v1/alerts/${ALERT_ID}/footage-token"
RESP=$(curl -sS -w '\n%{http_code}' -X POST \
  -H "Authorization: Bearer ${BEARER}" -H "Content-Type: application/json" -d '{}' \
  "${API_BASE}/api/v1/alerts/${ALERT_ID}/footage-token")
CODE=$(printf '%s' "$RESP" | tail -1); BODY=$(printf '%s' "$RESP" | sed '$d')
echo "   HTTP $CODE"
if [ "$CODE" != "200" ]; then bad "endpoint did not return 200: $BODY"; exit 1; fi
ok "token endpoint returned a manifest"

say "5. Download a presigned segment from the returned manifest (proves retrieval)"
SEG=$(printf '%s' "$BODY" | python3 -c 'import sys,json;print(next(l for l in json.load(sys.stdin)["manifest"].splitlines() if l.strip() and not l.startswith("#")))' 2>/dev/null)
if [ -z "$SEG" ]; then bad "could not parse a segment URL from manifest"; exit 1; fi
SCODE=$(curl -sS -o /dev/null -w '%{http_code}' "$SEG")
echo "   GET presigned seg -> HTTP $SCODE"
[ "$SCODE" = "200" ] && ok "FOOTAGE RETRIEVABLE end-to-end ✓" || bad "segment fetch failed ($SCODE)"
