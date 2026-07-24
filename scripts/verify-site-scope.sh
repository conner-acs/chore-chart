#!/usr/bin/env bash
#
# Verify the deployed backend now lets a site_admin assign ANY site in their org
# (SECURITY_DECISIONS Entry 012). Behavioural + NON-DESTRUCTIVE: it assigns one
# extra org site to a test user, asserts HTTP 200 (pre-change this was 403
# "You can only assign sites you manage"), then reverts to the original set.
#
# Prereqs: curl + jq. Uses the REST API only (no AWS creds needed).
#
# Usage:
#   API_BASE=https://72n9yjufvi.execute-api.ap-southeast-2.amazonaws.com \
#   EMAIL=you@org.com PASSWORD='...' [TEST_USER_ID=<operator-id>] \
#   ./scripts/verify-site-scope.sh
#
set -uo pipefail

API_BASE="${API_BASE:?set API_BASE to the prod httpApi url}"
EMAIL="${EMAIL:?set EMAIL (a site_admin login)}"
PASSWORD="${PASSWORD:?set PASSWORD}"
J="Content-Type: application/json"

say() { printf '\n\033[1m== %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓ %s\033[0m\n' "$1"; }
bad() { printf '  \033[31m✗ %s\033[0m\n' "$1"; }

say "1. Login"
LOGIN=$(curl -sS -X POST -H "$J" -d "$(jq -nc --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')" \
  "$API_BASE/api/v1/auth/login")
TOKEN=$(printf '%s' "$LOGIN" | jq -r '.access_token // .token // empty')
CALLER_ID=$(printf '%s' "$LOGIN" | jq -r '.user.id // .id // empty')
CALLER_ROLE=$(printf '%s' "$LOGIN" | jq -r '.user.role // .role // empty')
[ -n "$TOKEN" ] || { bad "login failed: $LOGIN"; exit 1; }
ok "logged in as ${EMAIL} (role=${CALLER_ROLE:-?})"
AUTH="Authorization: Bearer $TOKEN"

say "2. Org sites vs sites the caller personally holds"
ORG=$(curl -sS -H "$AUTH" "$API_BASE/api/v1/sites?scope=organization")
PERM=$(curl -sS -H "$AUTH" "$API_BASE/api/v1/sites?scope=permitted")
ORG_IDS=$(printf '%s' "$ORG" | jq -r '.[].id')
PERM_IDS=$(printf '%s' "$PERM" | jq -r '.[].id')
echo "   org sites:       $(printf '%s' "$ORG"  | jq 'length') | $(printf '%s' "$ORG_IDS" | tr '\n' ' ')"
echo "   caller holds:    $(printf '%s' "$PERM" | jq 'length') | $(printf '%s' "$PERM_IDS" | tr '\n' ' ')"
# A site in the org that the caller does NOT personally hold = the discriminating test.
EXTRA=$(comm -23 <(printf '%s\n' $ORG_IDS | sort -u) <(printf '%s\n' $PERM_IDS | sort -u) | head -1)
POSITIVE_ONLY=false
if [ -z "$EXTRA" ]; then
  POSITIVE_ONLY=true
  EXTRA=$(printf '%s\n' $ORG_IDS | head -1)
  bad "caller holds every org site -> cannot DISTINGUISH old vs new guard from this account."
  echo "     Falling back to a positive control (assign an org site, expect 200). To truly"
  echo "     confirm the loosening, run as a site_admin granted only a SUBSET of the org."
else
  ok "test site (in org, NOT held by caller): $EXTRA  <- pre-change this 403'd"
fi

say "3. Pick a test user to edit (not yourself)"
USERS=$(curl -sS -H "$AUTH" "$API_BASE/api/v1/users")
TEST_USER_ID="${TEST_USER_ID:-$(printf '%s' "$USERS" | jq -r --arg me "$CALLER_ID" '[.[]|select(.id!=$me)][0].id // empty')}"
[ -n "$TEST_USER_ID" ] || { bad "no other user in the org to test with; create an operator first, or set TEST_USER_ID"; exit 1; }
ORIG_SITES=$(printf '%s' "$USERS" | jq -c --arg u "$TEST_USER_ID" '[.[]|select(.id==$u)][0].sites // [] | map(.id)')
ORIG_ROLE=$(printf '%s' "$USERS" | jq -r --arg u "$TEST_USER_ID" '[.[]|select(.id==$u)][0].role // "operator"')
ok "editing user $TEST_USER_ID (role=$ORIG_ROLE); current sites=$ORIG_SITES"

say "4. PATCH: add the extra site (expect HTTP 200)"
NEW_SITES=$(jq -nc --argjson cur "$ORIG_SITES" --arg x "$EXTRA" '($cur + [$x]) | unique')
RESP=$(curl -sS -w '\n%{http_code}' -X PATCH -H "$AUTH" -H "$J" \
  -d "$(jq -nc --arg r "$ORIG_ROLE" --argjson s "$NEW_SITES" '{role:$r,site_ids:$s}')" \
  "$API_BASE/api/v1/users/$TEST_USER_ID")
CODE=$(printf '%s' "$RESP" | tail -1); BODY=$(printf '%s' "$RESP" | sed '$d')
echo "   HTTP $CODE"
PASS=false
if [ "$CODE" = "200" ]; then
  if printf '%s' "$BODY" | jq -e --arg x "$EXTRA" '.sites | map(.id) | index($x)' >/dev/null; then
    ok "assignment persisted (returned sites include $EXTRA)"
    $POSITIVE_ONLY && ok "positive control passed (endpoint works; can't prove loosening from this account)" \
                   || ok "DEPLOY CONFIRMED: site_admin assigned an org site they don't personally hold (was 403)"
    PASS=true
  else
    bad "200 but the site is not in the returned set: $BODY"
  fi
elif printf '%s' "$BODY" | grep -q "You can only assign sites you manage"; then
  bad "STILL 403 'You can only assign sites you manage' -> OLD code is live. Deploy didn't take (check stage/region/redeploy)."
else
  bad "unexpected: $BODY"
fi

say "5. Revert to the original site set"
RCODE=$(curl -sS -o /dev/null -w '%{http_code}' -X PATCH -H "$AUTH" -H "$J" \
  -d "$(jq -nc --arg r "$ORIG_ROLE" --argjson s "$ORIG_SITES" '{role:$r,site_ids:$s}')" \
  "$API_BASE/api/v1/users/$TEST_USER_ID")
[ "$RCODE" = "200" ] && ok "reverted to $ORIG_SITES" || bad "REVERT FAILED ($RCODE) - restore $TEST_USER_ID sites to $ORIG_SITES manually"

echo
$PASS && echo "RESULT: PASS" || { echo "RESULT: FAIL"; exit 1; }
