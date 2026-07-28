import { createRouter } from "../lib/middleware.js";
import { HttpError } from "../lib/response.js";
import { getOptionalSecret } from "../lib/secrets.js";

// Google Places proxy for address autocomplete on the site-create form.
//
// The GOOGLE_MAPS_API_KEY stays server-side (Secrets Manager bundle key
// `googleMapsApiKey`) - the browser only ever calls this AU (ap-southeast-2)
// endpoint, never Google directly. So the key is never exposed, the CSP needs no
// opening to maps.googleapis.com, and the offshore hop happens from the Sydney
// backend, not the client. Results are restricted to Australia (country:au) and
// only the typed address string is sent (no child/PII). See SECURITY_DECISIONS
// Entry 013. Both routes are site_admin+ (only they provision sites).

const AUTOCOMPLETE_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json";
const DETAILS_URL = "https://maps.googleapis.com/maps/api/place/details/json";

async function mapsKey() {
  const key = await getOptionalSecret("googleMapsApiKey");
  if (!key) throw new HttpError(503, "Address lookup is not configured");
  return key;
}

// GET /api/v1/places/autocomplete?q=<text> -> { predictions: [{ place_id, description }] }
async function autocomplete({ query }) {
  const input = String(query.q || "").trim();
  if (input.length < 3) return { predictions: [] };
  const key = await mapsKey();
  const url = `${AUTOCOMPLETE_URL}?${new URLSearchParams({
    input,
    components: "country:au",
    key,
  })}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new HttpError(502, `Address lookup failed (${data.status || "error"})`);
  }
  return {
    predictions: (data.predictions || []).map((p) => ({
      place_id: p.place_id,
      description: p.description,
    })),
  };
}

// GET /api/v1/places/details?place_id=<id> -> { latitude, longitude, formatted_address }
async function details({ query }) {
  const placeId = String(query.place_id || "").trim();
  if (!placeId) throw new HttpError(422, "place_id is required");
  const key = await mapsKey();
  const url = `${DETAILS_URL}?${new URLSearchParams({
    place_id: placeId,
    fields: "geometry,formatted_address",
    key,
  })}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK") {
    throw new HttpError(502, `Address lookup failed (${data.status || "error"})`);
  }
  const loc = data.result && data.result.geometry && data.result.geometry.location;
  if (!loc) throw new HttpError(502, "Selected place has no coordinates");
  return {
    latitude: loc.lat,
    longitude: loc.lng,
    formatted_address: data.result.formatted_address || "",
  };
}

export const handler = createRouter({
  "GET /api/v1/places/autocomplete": { fn: autocomplete, auth: "site_admin" },
  "GET /api/v1/places/details": { fn: details, auth: "site_admin" },
});
