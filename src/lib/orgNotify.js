import { listUsersByOrg } from "./repo/users.js";
import { sendSettingsChangedEmail } from "../services/email.js";
import { nowIso } from "./ids.js";

// Email every active site_admin of an org that its footage policy changed - what
// changed and who changed it. Best-effort: never throws to the caller, so a mail
// hiccup can't fail the settings write. `changes` is an array of human strings
// like "Footage retention: 7 -> 10 days".
export async function notifyOrgSettingsChanged({ org, changes, actor }) {
  if (!changes || changes.length === 0) return;
  try {
    const users = await listUsersByOrg(org.id);
    const admins = users.filter(
      (u) =>
        u &&
        u.role === "site_admin" &&
        u.is_active !== false &&
        u.email &&
        // Respect the recipient's email-notification preference (default on) - this
        // is a notification, not a security email, so opted-out admins are skipped.
        u.email_notifications !== false
    );
    if (admins.length === 0) return;
    const actorName = actor.full_name || actor.email || "An administrator";
    await Promise.all(
      admins.map((admin) =>
        sendSettingsChangedEmail({
          toEmail: admin.email,
          fullName: admin.full_name,
          orgName: org.name,
          changes,
          actorName,
        })
      )
    );
  } catch (err) {
    console.warn("[settings] change notification failed:", err.message);
  }
}

// Build the human-readable change list + apply the new footage-policy fields to
// the org record in place (records who/when). Returns the change strings (empty
// if nothing actually changed). Shared by the site-admin /settings edit and the
// superuser org edit.
export function applyFootagePolicy(org, body, actor) {
  const changes = [];
  if (body.footage_sla_days !== undefined && body.footage_sla_days !== org.footage_sla_days) {
    changes.push(
      `Footage retention: ${org.footage_sla_days ?? 7} -> ${body.footage_sla_days} days`
    );
    org.footage_sla_days = body.footage_sla_days;
  }
  if (
    body.require_restore_approval !== undefined &&
    body.require_restore_approval !== (org.require_restore_approval ?? false)
  ) {
    changes.push(
      `Restore approval required: ${org.require_restore_approval ?? false} -> ${body.require_restore_approval}`
    );
    org.require_restore_approval = body.require_restore_approval;
  }
  if (
    body.allow_operator_direct_resolve !== undefined &&
    body.allow_operator_direct_resolve !== (org.allow_operator_direct_resolve ?? false)
  ) {
    changes.push(
      `Operators resolve directly: ${org.allow_operator_direct_resolve ?? false} -> ${body.allow_operator_direct_resolve}`
    );
    org.allow_operator_direct_resolve = body.allow_operator_direct_resolve;
  }
  if (changes.length) {
    org.settings_modified_by = actor.email || actor.id || null;
    org.settings_modified_at = nowIso();
  }
  return changes;
}
