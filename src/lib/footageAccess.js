import { HttpError } from "./response.js";

// Footage is the most sensitive data SafeDay handles. On top of the per-site
// permission check (userCanAccessSite), viewing footage HISTORY is further
// restricted to staff on the approved partner email domains. Domains are
// configurable via FOOTAGE_ALLOWED_EMAIL_DOMAINS (comma-separated); the default
// is the three partner orgs authorised to review childcare footage.
//
// This gate is applied to the footage-history path only, not to live-alert
// clips, so centre-operated accounts on other domains keep their existing
// alert-review access.
const DEFAULT_ALLOWED_DOMAINS = [
  "ascensioncloudsolutions.com",
  "artoflogic.ai",
  "barrickgroup.au",
];

export function allowedFootageDomains() {
  const raw = process.env.FOOTAGE_ALLOWED_EMAIL_DOMAINS;
  if (!raw) return DEFAULT_ALLOWED_DOMAINS;
  return raw
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter(Boolean);
}

// Throw 403 unless the user's email is on an approved footage-review domain.
export function assertFootageEmailAllowed(user) {
  const email = (user?.email || "").toLowerCase();
  const at = email.lastIndexOf("@");
  const domain = at === -1 ? "" : email.slice(at + 1);
  if (!domain || !allowedFootageDomains().includes(domain)) {
    throw new HttpError(403, "Your account is not authorised to access footage history");
  }
}
