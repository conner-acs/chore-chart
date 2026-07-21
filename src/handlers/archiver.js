// Footage archiver: moves footage for alerts whose SLA retention window has
// lapsed into Glacier Deep Archive and marks the alert footage_state = archived.
// Runs on a schedule (see serverless.yml) and on-demand via the admin
// archive-sweep route. Placeholder mode writes a marker object per alert; real
// Nx capture will later land the actual clip at the same key, unchanged here.
import { listAllAlerts, putAlert } from "../lib/repo/alerts.js";
import { getSite } from "../lib/repo/sites.js";
import {
  getOrganization,
  incrementArchivedCount,
} from "../lib/repo/organizations.js";
import { orgSlaDays, slaDeadlineMs } from "../lib/sla.js";
import { archivePlaceholder } from "../lib/footageArchive.js";
import { nowIso } from "../lib/ids.js";

// Archive every alert whose footage is still "hot" and whose SLA deadline has
// passed. site_id -> { slaDays, orgId } is cached across the sweep so each org
// is resolved once. Returns a summary { scanned, archived, errors }.
export async function sweep() {
  const alerts = await listAllAlerts();
  const now = Date.now();
  const siteMeta = new Map();
  let archived = 0;
  const errors = [];

  for (const alert of alerts) {
    if ((alert.footage_state || "hot") !== "hot") continue;

    let meta = siteMeta.get(alert.site_id);
    if (!meta) {
      const site = await getSite(alert.site_id);
      const org = site ? await getOrganization(site.organization_id) : null;
      meta = { slaDays: orgSlaDays(org), orgId: org ? org.id : null };
      siteMeta.set(alert.site_id, meta);
    }
    if (now <= slaDeadlineMs(alert, meta.slaDays)) continue; // retention not lapsed

    try {
      const key = await archivePlaceholder(alert);
      alert.footage_state = "archived";
      alert.footage_key = key;
      alert.archived_at = nowIso();
      await putAlert(alert);
      if (meta.orgId) await incrementArchivedCount(meta.orgId, 1);
      archived += 1;
    } catch (err) {
      errors.push({ alert_id: alert.id, error: err.message });
    }
  }
  return { scanned: alerts.length, archived, errors };
}

// EventBridge schedule entry point.
export const handler = async () => {
  const result = await sweep();
  console.info("[archiver] sweep complete:", JSON.stringify(result));
  return result;
};
