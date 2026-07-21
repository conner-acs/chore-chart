# SES email setup (production) — safeday.com.au

Production email (stage `prod`, region `ap-southeast-2`, account `417183877817`)
sends via **Amazon SES** instead of Mailtrap. `EMAIL_PROVIDER=ses`,
`SES_FROM=no-reply@safeday.com.au`. This doc tracks what's done and the manual
steps that remain (DNS + SES production access).

## Existing DNS (Cloudflare) — already in place

`safeday.com.au` DNS is on **Cloudflare**; inbound mail is **Microsoft 365**.
Relevant records found:

- **SPF** already authorises SES: `v=spf1 include:spf.protection.outlook.com include:amazonses.com ~all` ✅
- **DMARC** present: `v=DMARC1; p=none; rua=mailto:contact@safeday.com.au` ✅

So only **DKIM** remains for SES domain verification.

## Done (in AWS, ap-southeast-2)

- SES **domain identity** `safeday.com.au` created (Easy DKIM, RSA-2048) — status `PENDING`.
- SES **email identity** `conner@ascensioncloudsolutions.com` created — verification
  email sent (must be clicked; required because SES is in the **sandbox**).
- Lambda role granted `ses:SendEmail`/`SendRawEmail`, restricted to
  `From: *@safeday.com.au`.
- `testEmailTo=conner@ascensioncloudsolutions.com` added to the `safeday/prod/app`
  secret (existing keys preserved).
- `POST /api/v1/admin/test-email` (superuser) deployed — fires a test email to
  `testEmailTo` and returns `{provider, from, to, sent, messageId?, error?}`.

## TODO 1 — Add the 3 DKIM CNAME records to Cloudflare

Add these as **CNAME**, **DNS only (grey cloud, NOT proxied)**:

| Name (host) | Target |
| --- | --- |
| `2arslmqoh3gvmom5a4l5he332yvyihzp._domainkey` | `2arslmqoh3gvmom5a4l5he332yvyihzp.dkim.amazonses.com` |
| `dtxejbovmrne4iuhoeky6jg7xdiybf6x._domainkey` | `dtxejbovmrne4iuhoeky6jg7xdiybf6x.dkim.amazonses.com` |
| `x5dz7cwnqtwzahcudpej6w7vexwenvql._domainkey` | `x5dz7cwnqtwzahcudpej6w7vexwenvql.dkim.amazonses.com` |

Re-fetch tokens any time with:

```bash
AWS_PROFILE=417183877817_EngineerAdmin aws sesv2 get-email-identity \
  --region ap-southeast-2 --email-identity safeday.com.au \
  --query 'DkimAttributes.Tokens'
```

SES auto-detects within minutes–hours; verify it flipped to `SUCCESS`:

```bash
AWS_PROFILE=417183877817_EngineerAdmin aws sesv2 get-email-identity \
  --region ap-southeast-2 --email-identity safeday.com.au \
  --query '{verified:VerifiedForSendingStatus, dkim:DkimAttributes.Status}'
```

## TODO 2 — Verify the test recipient

Click the verification link in the email AWS sent to
`conner@ascensioncloudsolutions.com`. Re-send if needed:

```bash
AWS_PROFILE=417183877817_EngineerAdmin aws sesv2 create-email-identity \
  --region ap-southeast-2 --email-identity conner@ascensioncloudsolutions.com
```

(While SES is in the sandbox, **every recipient** must be a verified identity.)

## TODO 3 — Request SES production access (exit sandbox)

Sandbox = 200 emails/day, 1/sec, and you can only send to verified addresses.
To email real operators, request production access (Console → SES → Account
dashboard → "Request production access", region **ap-southeast-2**). Usually
approved within ~24h.

## Test it

Once DKIM = `SUCCESS` and the recipient is verified, fire a test:

```bash
# with a prod superuser token:
curl -s -X POST https://72n9yjufvi.execute-api.ap-southeast-2.amazonaws.com/api/v1/admin/test-email \
  -H "Authorization: Bearer <superuser-jwt>"
# -> {"provider":"ses","from":"no-reply@safeday.com.au","to":"conner@...","sent":true,"messageId":"..."}
```

or via the suite (auto-runs step [10] when logged in as a superuser):

```bash
API=https://72n9yjufvi.execute-api.ap-southeast-2.amazonaws.com \
SAFEDAY_EMAIL=<superuser-email> SAFEDAY_PASSWORD=<password> ./test.sh
```

## Switching the production sender later

`SES_FROM` is set per-stage in `serverless.yml` (`custom.sesFrom.prod`). Change
it + redeploy to use a different verified address (e.g. `alerts@safeday.com.au`).
The IAM policy already allows any `*@safeday.com.au` sender.
