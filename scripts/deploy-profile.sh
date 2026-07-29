#!/usr/bin/env bash
#
# Deploy safeday-serverless to a chosen AWS profile AND populate its Secrets
# Manager secret — safe to run from a brand-new terminal.
#
# Usage:
#   scripts/deploy-profile.sh <aws-profile> [stage] [region]
#
#   scripts/deploy-profile.sh my-other-profile            # stage dev, us-east-1
#   scripts/deploy-profile.sh my-other-profile prod us-west-2
#
# Secret values come from scripts/../.env.secrets (gitignored) or the environment;
# anything missing is generated (secretKey + webhookSecret) so the stack is usable
# immediately. Values are written to the secret via a temp file — never on the
# command line, never echoed.
#
# Requires: aws CLI v2, node/npx (Serverless Framework v4 — be logged in via
# `npx serverless login` or have SERVERLESS_ACCESS_KEY set), openssl, bash.
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

# ---- args ---------------------------------------------------------------
PROFILE="${1:-}"
STAGE="${2:-${STAGE:-dev}}"
REGION="${3:-${REGION:-us-east-1}}"

if [ -z "$PROFILE" ]; then
  echo "usage: scripts/deploy-profile.sh <aws-profile> [stage] [region]" >&2
  exit 1
fi

note() { printf '\033[36m▶ %s\033[0m\n' "$1"; }
die()  { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

command -v aws  >/dev/null || die "aws CLI not found"
command -v npx  >/dev/null || die "npx (Node.js) not found"
command -v openssl >/dev/null || die "openssl not found"

# ---- 0. verify the target profile authenticates ------------------------
note "Checking AWS profile '$PROFILE'…"
ACCOUNT=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text) \
  || die "profile '$PROFILE' is not configured or has invalid credentials (try: aws configure --profile $PROFILE)"
echo "  profile '$PROFILE' → account $ACCOUNT, region $REGION, stage $STAGE"

# ---- 1. resolve secret values ------------------------------------------
# Pull from .env.secrets (gitignored) or the environment; generate what's absent.
if [ -f .env.secrets ]; then
  # Guard before sourcing: every non-comment/non-blank line must be KEY=value.
  # A JSON value pasted multi-line (or unquoted) otherwise makes `source` try to
  # run it, failing with cryptic errors like `username:: command not found`.
  BAD_LINE=$(grep -nvE '^[[:space:]]*#|^[[:space:]]*$|^[A-Za-z_][A-Za-z0-9_]*=' .env.secrets | head -1 || true)
  if [ -n "$BAD_LINE" ]; then
    die ".env.secrets line ${BAD_LINE%%:*} is not a KEY=value line. JSON values (e.g. NX_CREDENTIALS_JSON) must be a SINGLE line wrapped in SINGLE QUOTES, no // comments. See .env.secrets.example."
  fi
  note "Loading secret values from .env.secrets"
  set -a; . ./.env.secrets; set +a
fi
SECRET_KEY="${SECRET_KEY:-$(openssl rand -hex 32)}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(openssl rand -hex 32)}"
NX_KEY="${NX_CREDENTIAL_ENCRYPTION_KEY:-}"
MAILTRAP="${MAILTRAP_API_TOKEN:-}"
SENDGRID="${SENDGRID_PROD_API_TOKEN:-}"  # prod email sender (SendGrid); see src/services/email.js

[ -n "$NX_KEY" ] || echo "  ⚠ NX_CREDENTIAL_ENCRYPTION_KEY is empty — Nx test-connection/cameras/footage will 502. Set it in .env.secrets if migrating encrypted Nx passwords." >&2

# Per-org Nx Witness credentials as a JSON map: {"<org_id>":{"username":"..","password":".."}}.
# Stored in the secret bundle under `nxCredentials`; read by the footage-history path.
# Defaults to an empty map so a deploy without creds still succeeds (footage history
# then returns 502 "No Nx credentials configured" until an org is populated).
# NB: don't inline the default as ${VAR:-{}} — bash treats the first '}' as the
# end of the expansion and appends the second '}' literally, corrupting any set
# value into '…}}'. Default explicitly instead.
NX_CREDENTIALS_JSON="${NX_CREDENTIALS_JSON:-}"
[ -n "$NX_CREDENTIALS_JSON" ] || NX_CREDENTIALS_JSON='{}'
# One credential set whitelisted to several orgs: {"username","password","orgIds":[..]}.
# Stored under `nxSharedCredentials`; per-org entries in nxCredentials override it.
NX_SHARED_CREDENTIALS_JSON="${NX_SHARED_CREDENTIALS_JSON:-null}"

# ---- 2. deploy ----------------------------------------------------------
note "Deploying stack 'safeday-$STAGE' to profile '$PROFILE'…"
npx serverless deploy --aws-profile "$PROFILE" --stage "$STAGE" --region "$REGION"

# ---- 3. populate the secret --------------------------------------------
# MERGE the managed keys into the existing secret (rather than overwrite it), so
# keys set out-of-band — sendgridProdApiToken, googleMapsApiKey, testEmailTo, … —
# are preserved across deploys. jq's `+` is a shallow merge (right side wins per
# top-level key), so each managed key REPLACES its old value while extras remain.
SECRET_ID="safeday/${STAGE}/app"
note "Updating secret '$SECRET_ID' (merge)…"
command -v jq >/dev/null || die "jq is required to update the secret (please install jq)"

EXIST="$(mktemp)"; MANAGED="$(mktemp)"; MERGED="$(mktemp)"
trap 'rm -f "$EXIST" "$MANAGED" "$MERGED"' EXIT

# Current secret (serverless creates it with placeholders on first deploy).
aws secretsmanager get-secret-value --profile "$PROFILE" --region "$REGION" \
  --secret-id "$SECRET_ID" --query SecretString --output text > "$EXIST" 2>/dev/null \
  || echo '{}' > "$EXIST"

# Keys this script manages, from .env.secrets / the environment. sendgridProdApiToken
# is only set when SENDGRID_PROD_API_TOKEN is provided, so a blank never clobbers it.
jq -n --arg sk "$SECRET_KEY" --arg nx "$NX_KEY" --arg wh "$WEBHOOK_SECRET" \
      --arg mt "$MAILTRAP" --arg sg "$SENDGRID" \
      --argjson nxc "$NX_CREDENTIALS_JSON" --argjson nxs "$NX_SHARED_CREDENTIALS_JSON" \
      '{secretKey:$sk, nxCredentialEncryptionKey:$nx, webhookSecret:$wh, mailtrapApiToken:$mt,
        nxCredentials:$nxc, nxSharedCredentials:$nxs}
       + (if $sg != "" then {sendgridProdApiToken:$sg} else {} end)' > "$MANAGED"

# existing + managed (top-level shallow merge; managed wins, extras preserved).
jq -s '.[0] + .[1]' "$EXIST" "$MANAGED" > "$MERGED"

aws secretsmanager put-secret-value \
  --profile "$PROFILE" --region "$REGION" \
  --secret-id "$SECRET_ID" \
  --secret-string "file://$MERGED" \
  --query 'ARN' --output text >/dev/null \
  || die "failed to write secret '$SECRET_ID' (was the deploy successful?)"

echo "  secret '$SECRET_ID' updated (managed keys set; existing extras preserved)"

# ---- 4. done ------------------------------------------------------------
note "Done."
echo
echo "  Stack:  safeday-$STAGE   (account $ACCOUNT, $REGION)"
echo "  Secret: $SECRET_ID"
echo
echo "  Next — load the data into this account's DynamoDB:"
echo "    AWS_PROFILE=$PROFILE STAGE=$STAGE AWS_REGION=$REGION npm run migrate"
echo
echo "  Endpoints:"
aws cloudformation describe-stacks --stack-name "safeday-$STAGE" \
  --profile "$PROFILE" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='HttpApiUrl'||OutputKey=='ServiceEndpointWebsocket'||OutputKey=='FootageLambdaFunctionUrl'].[OutputKey,OutputValue]" \
  --output text | sed 's/^/    /'
