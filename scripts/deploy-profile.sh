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
  note "Loading secret values from .env.secrets"
  set -a; . ./.env.secrets; set +a
fi
SECRET_KEY="${SECRET_KEY:-$(openssl rand -hex 32)}"
WEBHOOK_SECRET="${WEBHOOK_SECRET:-$(openssl rand -hex 32)}"
NX_KEY="${NX_CREDENTIAL_ENCRYPTION_KEY:-}"
MAILTRAP="${MAILTRAP_API_TOKEN:-}"

[ -n "$NX_KEY" ] || echo "  ⚠ NX_CREDENTIAL_ENCRYPTION_KEY is empty — Nx test-connection/cameras/footage will 502. Set it in .env.secrets if migrating encrypted Nx passwords." >&2

# ---- 2. deploy ----------------------------------------------------------
note "Deploying stack 'safeday-$STAGE' to profile '$PROFILE'…"
npx serverless deploy --aws-profile "$PROFILE" --stage "$STAGE" --region "$REGION"

# ---- 3. populate the secret --------------------------------------------
# serverless created safeday/<stage>/app with placeholders; overwrite it.
SECRET_ID="safeday/${STAGE}/app"
note "Writing secret '$SECRET_ID'…"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
if command -v jq >/dev/null; then
  jq -n --arg sk "$SECRET_KEY" --arg nx "$NX_KEY" --arg wh "$WEBHOOK_SECRET" --arg mt "$MAILTRAP" \
    '{secretKey:$sk, nxCredentialEncryptionKey:$nx, webhookSecret:$wh, mailtrapApiToken:$mt}' > "$TMP"
else
  # Fallback JSON builder (values are keys/tokens with no quotes/backslashes).
  printf '{"secretKey":"%s","nxCredentialEncryptionKey":"%s","webhookSecret":"%s","mailtrapApiToken":"%s"}' \
    "$SECRET_KEY" "$NX_KEY" "$WEBHOOK_SECRET" "$MAILTRAP" > "$TMP"
fi

aws secretsmanager put-secret-value \
  --profile "$PROFILE" --region "$REGION" \
  --secret-id "$SECRET_ID" \
  --secret-string "file://$TMP" \
  --query 'ARN' --output text >/dev/null \
  || die "failed to write secret '$SECRET_ID' (was the deploy successful?)"

echo "  secret '$SECRET_ID' populated"

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
