// Reconcile Nx Witness bookmarks against SafeDay alerts to surface inconsistencies:
// bookmarks with no matching alert ("an alert that was never generated") and alerts
// with no matching bookmark. Pure + side-effect free so it is unit-testable; the
// handler supplies the bookmarks (from the VMS) and alerts (from DynamoDB) and does
// the CloudWatch logging.
//
// Join keys, in order of confidence:
//   1. the bookmark guid stored on the alert (alert.nx_bookmark_id == bookmark.id)
//   2. fallback: same camera + start-time within MATCH_TOLERANCE_MS (for alerts
//      whose plugin/test path left nx_bookmark_id null).
// Camera ids are compared brace/case-insensitively (Nx uses "{uuid}", alerts may
// store the bare uuid). A matched alert is consumed so one alert can't absorb
// multiple bookmarks and hide a real gap.

// How close (ms) an alert's start must be to a bookmark's startTimeMs to count as
// the same event when there is no bookmark-id link. Bookmarks are ~6s windows.
export const MATCH_TOLERANCE_MS = 60_000;

const normId = (v) => String(v ?? "").replace(/[{}]/g, "").toLowerCase().trim();
const isNonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;
const bmStartMs = (b) => {
  const t = Number(b && b.startTimeMs);
  return Number.isFinite(t) ? t : NaN;
};
const alertStartMs = (a) => {
  const t = a && a.start_timestamp ? Date.parse(a.start_timestamp) : NaN;
  return Number.isFinite(t) ? t : NaN;
};

const summarizeBookmark = (b) => ({
  id: b.id || b.guid || null,
  camera_id: b.deviceId || b.cameraId || null,
  name: b.name || null,
  start_ms: Number.isFinite(bmStartMs(b)) ? bmStartMs(b) : null,
  duration_ms: b.durationMs ?? null,
});
const summarizeAlert = (a) => ({
  id: a.id,
  camera_id: a.camera_id || null,
  alert_type: a.alert_type || null,
  start_timestamp: a.start_timestamp || null,
  nx_bookmark_id: isNonEmptyStr(a.nx_bookmark_id) ? a.nx_bookmark_id : null,
});

// bookmarks: raw Nx bookmark objects. alerts: raw alert records for the site.
// fromMs: ignore bookmarks AND alerts that START before this cutoff (the per-site
// "reconcile from" date). Returns { window_from_ms, counts, matched,
// bookmarks_without_alert, alerts_without_bookmark }.
export function reconcileBookmarks(
  bookmarks,
  alerts,
  { fromMs = 0, toleranceMs = MATCH_TOLERANCE_MS } = {}
) {
  const from = Number.isFinite(fromMs) ? fromMs : 0;

  // Bookmarks are windowed at the hard cutoff. Alerts used for MATCHING are widened
  // by the tolerance: a bookmark and its alert are one event whose two clocks (Nx
  // startTimeMs vs alert start_timestamp) legitimately differ by up to toleranceMs,
  // so an alert just before the cutoff can still vindicate a bookmark just after it.
  // The gap report + counts below re-apply the hard `from` cutoff to the alert side.
  const bms = (bookmarks || []).filter((b) => Number.isFinite(bmStartMs(b)) && bmStartMs(b) >= from);
  const als = (alerts || []).filter(
    (a) => Number.isFinite(alertStartMs(a)) && alertStartMs(a) >= from - toleranceMs
  );

  // Indexes for lookup.
  const alertByBookmarkId = new Map(); // normId(guid) -> alert
  const alertsByCamera = new Map(); // normId(camera) -> [{ startMs, alert }]
  for (const a of als) {
    if (isNonEmptyStr(a.nx_bookmark_id)) alertByBookmarkId.set(normId(a.nx_bookmark_id), a);
    const cam = normId(a.camera_id);
    if (!alertsByCamera.has(cam)) alertsByCamera.set(cam, []);
    alertsByCamera.get(cam).push({ startMs: alertStartMs(a), alert: a });
  }

  const available = new Set(als.map((a) => a.id)); // alerts not yet matched
  const matched = [];
  const bookmarksWithoutAlert = [];

  // Pass 1: resolve the authoritative nx_bookmark_id links for ALL bookmarks first,
  // so the weaker camera+time fallback can never steal an alert that another bookmark
  // owns by id (which would invert both the match and the reported gap).
  const needFallback = [];
  for (const b of bms) {
    const guid = normId(b.id || b.guid);
    let alert = guid ? alertByBookmarkId.get(guid) : undefined;
    if (alert && !available.has(alert.id)) alert = undefined;
    if (alert) {
      available.delete(alert.id);
      matched.push({ bookmark: summarizeBookmark(b), alert_id: alert.id });
    } else {
      needFallback.push(b);
    }
  }

  // Pass 2: fallback — same camera + closest start within tolerance, over the alerts
  // still unclaimed after every id-link is resolved.
  for (const b of needFallback) {
    const cam = normId(b.deviceId || b.cameraId);
    const bs = bmStartMs(b);
    let best = null;
    let bestDelta = Infinity;
    for (const c of alertsByCamera.get(cam) || []) {
      if (!available.has(c.alert.id)) continue;
      const delta = Math.abs(c.startMs - bs);
      if (delta <= toleranceMs && delta < bestDelta) {
        best = c.alert;
        bestDelta = delta;
      }
    }
    if (best) {
      available.delete(best.id);
      matched.push({ bookmark: summarizeBookmark(b), alert_id: best.id });
    } else {
      bookmarksWithoutAlert.push(summarizeBookmark(b));
    }
  }

  // A leftover alert is only a real gap if it is itself at/after the cutoff — a
  // pre-cutoff alert that was widened in purely for matching must not be reported.
  const inWindow = (a) => alertStartMs(a) >= from;
  const alertsWithoutBookmark = als
    .filter((a) => available.has(a.id) && inWindow(a))
    .map(summarizeAlert);

  return {
    window_from_ms: from,
    counts: {
      bookmarks: bms.length,
      alerts: als.filter(inWindow).length,
      matched: matched.length,
      bookmarks_without_alert: bookmarksWithoutAlert.length,
      alerts_without_bookmark: alertsWithoutBookmark.length,
    },
    matched,
    bookmarks_without_alert: bookmarksWithoutAlert,
    alerts_without_bookmark: alertsWithoutBookmark,
  };
}
