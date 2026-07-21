#!/usr/bin/env bash
#
# Data migration: stamp every alert with a footage_hls_prefix that points at a demo
# HLS clip that ACTUALLY EXISTS in the footage bucket, so the footage-token endpoint
# serves footage for every alert regardless of its type.
#
# The endpoint already falls back to a default demo clip in code, so this migration
# is OPTIONAL - use it if you'd rather fix the data than redeploy the backend, or to
# pin specific alerts to specific clips. It only ever writes prefixes whose index.m3u8
# is present in S3, so it can't create broken pointers.
#
# Prereqs: aws CLI + jq. Run the transcode tool FIRST (it uploads the demo HLS).
#
# Usage:
#   STAGE=prod REGION=ap-southeast-2 PROFILE=417183877817_EngineerAdmin \
#   ./scripts/migrate-alert-footage-prefix.sh [--dry-run]
#
set -euo pipefail

STAGE="${STAGE:-prod}"
REGION="${REGION:-ap-southeast-2}"
PROFILE="${PROFILE:-417183877817_EngineerAdmin}"
BUCKET="${BUCKET:-safeday-${STAGE}-footage}"
ALERTS_TABLE="${ALERTS_TABLE:-safeday-${STAGE}-alerts}"
DEFAULT_TYPE="${DEFAULT_TYPE:-child_in_no_go_zone}"
DRY_RUN=false; [ "${1:-}" = "--dry-run" ] && DRY_RUN=true
AWS=(aws --region "$REGION" --profile "$PROFILE")

# Which demo clip types have an index.m3u8 uploaded? (the set we may point at)
mapfile -t HAVE < <(
  "${AWS[@]}" s3 ls "s3://${BUCKET}/footage/${STAGE}/_demo/" 2>/dev/null \
    | awk '/PRE /{gsub(/\//,"",$2); print $2}'
)
[ "${#HAVE[@]}" -gt 0 ] || { echo "ERROR: no demo clips under s3://${BUCKET}/footage/${STAGE}/_demo/ — run the transcode tool first." >&2; exit 1; }
printf 'demo clips present: %s\n' "${HAVE[*]}"
have_clip() { local t; for t in "${HAVE[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }
have_clip "$DEFAULT_TYPE" || { echo "ERROR: default clip '$DEFAULT_TYPE' not uploaded; set DEFAULT_TYPE= to one of: ${HAVE[*]}" >&2; exit 1; }

updated=0; scanned=0; NEXT=""
while :; do
  PAGE=$("${AWS[@]}" dynamodb scan --table-name "$ALERTS_TABLE" \
    --projection-expression "id, alert_type" \
    ${NEXT:+--starting-token "$NEXT"} --output json)
  while IFS=$'\t' read -r ID ATYPE; do
    [ -n "$ID" ] || continue
    scanned=$((scanned + 1))
    TYPE_LC=$(printf '%s' "$ATYPE" | tr '[:upper:]' '[:lower:]')
    CLIP="$DEFAULT_TYPE"; have_clip "$TYPE_LC" && CLIP="$TYPE_LC"
    PREFIX="footage/${STAGE}/_demo/${CLIP}/"
    if $DRY_RUN; then
      echo "  would set ${ID} (${ATYPE:-<none>}) -> ${PREFIX}"
    else
      "${AWS[@]}" dynamodb update-item --table-name "$ALERTS_TABLE" \
        --key "{\"id\":{\"S\":\"${ID}\"}}" \
        --update-expression "SET footage_hls_prefix = :p" \
        --expression-attribute-values "{\":p\":{\"S\":\"${PREFIX}\"}}"
      echo "  set ${ID} (${ATYPE:-<none>}) -> ${PREFIX}"
    fi
    updated=$((updated + 1))
  done < <(printf '%s' "$PAGE" | jq -r '.Items[] | [.id.S, (.alert_type.S // "")] | @tsv')
  NEXT=$(printf '%s' "$PAGE" | jq -r '.NextToken // empty')
  [ -n "$NEXT" ] || break
done
printf '\n%s %d/%d alert(s).\n' "$([ "$DRY_RUN" = true ] && echo 'Would update' || echo 'Updated')" "$updated" "$scanned"
