// Integration test: send the real "user email validation" (set-password) email
// via Amazon SES, from the production sender, to a real inbox. This sends an
// ACTUAL email and requires SES to be verified for sending.
//
// Run (engineer profile, prod sender):
//   AWS_PROFILE=417183877817_EngineerAdmin EMAIL_PROVIDER=ses \
//   SES_FROM=no-reply@safeday.com.au SES_REGION=ap-southeast-2 ENVIRONMENT=prod \
//   PUBLIC_BASE_URL=https://safeday.com.au node --test scripts/test-ses-email.mjs
import test from "node:test";
import assert from "node:assert";
import { deliver } from "../src/services/email.js";

const TO = "tech@ascensioncloudsolutions.com";

test("SES sends the user email-validation message to " + TO, async () => {
  // Mirror the real set-password invite content.
  const link = "https://safeday.com.au/set-password.html?token=demo-verification-token";
  const result = await deliver({
    toEmail: TO,
    subject: "Welcome to SafeDay - verify your account & set your password",
    text:
      "Hi there,\n\nYour SafeDay account has been created. Verify your email and " +
      "set your password using the link below:\n\n" + link + "\n\n- The SafeDay team",
    html:
      "<p>Hi there,</p><p>Your SafeDay account has been created. Verify your email " +
      'and set your password using the link below:</p><p><a href="' + link +
      '">Verify &amp; set your password</a></p><p>- The SafeDay team</p>',
    category: "account-invite",
  });

  console.log("SES result:", JSON.stringify(result));
  assert.equal(
    result.sent,
    true,
    `email was not delivered (provider=${result.provider}, from=${result.from}): ${result.error}`
  );
  assert.ok(result.messageId, "expected a MessageId from SES");
});
