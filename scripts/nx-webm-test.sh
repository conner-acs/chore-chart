#!/usr/bin/env bash
#
# nx-webm-test.sh — end-to-end test of the Nx Witness footage integration,
# mirroring exactly how the SafeDay mobile app (Childcare-App-Backend) does it:
#
#   1. POST /rest/v2/login/sessions   {username,password,setCookie:false}  -> {token}
#   2. GET  /rest/v2/devices          (Bearer token)                        -> cameras
#   3. GET  /rest/v2/devices/{id}/bookmarks (Bearer)                        -> windows
#   4. GET  /media/{cameraId}.webm?pos=START&endPos=END (Bearer)           -> clip
#
# The ONLY difference from the app's clip export is the extension: .mp4 -> .webm.
#
# Usage:
#   NX_HOST=https://sunkids-childcare-katana-1.tail2e758.ts.net \
#   NX_USER=youruser NX_PASS='yourpass' \
#   ./nx-webm-test.sh [CAMERA_ID] [START_MS] [END_MS]
#
# With no CAMERA_ID it lists devices and stops so you can pick one.
# With no START/END it pulls the camera's most recent bookmark window.

set -euo pipefail

HOST="${NX_HOST:?set NX_HOST, e.g. https://sunkids-childcare-katana-1.tail2e758.ts.net}"
USER="${NX_USER:?set NX_USER}"
PASS="${NX_PASS:?set NX_PASS}"
HOST="${HOST%/}"
CAM="${1:-}"
START_MS="${2:-}"
END_MS="${3:-}"

# The tailscale funnel presents a valid cert; a bare Nx host is self-signed. Add
# -k automatically only if a plain request fails TLS verification.
CURL=(curl -sS --max-time 300)
if ! curl -sS -o /dev/null --max-time 15 "$HOST/rest/v2/login/sessions" 2>/dev/null; then
  echo "note: TLS verify failed, retrying with -k (self-signed Nx cert)" >&2
  CURL=(curl -sS -k --max-time 300)
fi

jq_get() { python3 -c 'import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))' "$1"; }

echo "== 1. login =="
TOKEN=$("${CURL[@]}" -X POST "$HOST/rest/v2/login/sessions" \
  -H 'content-type: application/json' \
  --data "$(python3 -c 'import json,os;print(json.dumps({"username":os.environ["NX_USER"],"password":os.environ["NX_PASS"],"setCookie":False}))')" \
  | jq_get 'd["token"]')
[ -n "$TOKEN" ] || { echo "login failed — check credentials"; exit 1; }
echo "token acquired: ${TOKEN:0:12}…"
AUTH=(-H "Authorization: Bearer $TOKEN")

echo "== 2. devices =="
"${CURL[@]}" "${AUTH[@]}" "$HOST/rest/v2/devices" \
  | python3 -c 'import sys,json
d=json.load(sys.stdin)
d=d if isinstance(d,list) else d.get("devices",d.get("reply",[]))
for c in d: print(f"  {c.get(\"id\") or c.get(\"physicalId\")}  {c.get(\"name\",\"\")}")'

if [ -z "$CAM" ]; then
  echo; echo "Pick a CAMERA_ID from above and re-run:"; echo "  $0 <CAMERA_ID> [START_MS] [END_MS]"; exit 0
fi

if [ -z "$START_MS" ] || [ -z "$END_MS" ]; then
  echo "== 3. most-recent bookmark for $CAM =="
  BM=$("${CURL[@]}" "${AUTH[@]}" "$HOST/rest/v2/devices/$CAM/bookmarks?limit=1&order=desc" 2>/dev/null \
     || "${CURL[@]}" "${AUTH[@]}" "$HOST/ec2/bookmarks?cameraId=$CAM")
  echo "$BM" | head -c 600; echo
  START_MS=$(echo "$BM" | jq_get 'd[0]["startTimeMs"]' 2>/dev/null || true)
  DUR=$(echo "$BM" | jq_get 'd[0].get("durationMs",60000)' 2>/dev/null || echo 60000)
  [ -n "$START_MS" ] && END_MS=$(( START_MS + DUR ))
  [ -n "${START_MS:-}" ] || { echo "no bookmark found; pass START_MS END_MS explicitly (epoch ms)"; exit 1; }
fi

echo "== 4. export WEBM clip  pos=$START_MS endPos=$END_MS =="
OUT="clip-$CAM-$START_MS.webm"
CODE=$("${CURL[@]}" "${AUTH[@]}" -o "$OUT" -w '%{http_code}' \
  "$HOST/media/$CAM.webm?pos=$START_MS&endPos=$END_MS")
echo "HTTP $CODE  ->  $OUT ($(wc -c < "$OUT") bytes)"
echo "magic bytes: $(xxd -l4 "$OUT" 2>/dev/null | awk '{print $2$3}')  (1a45dfa3 = valid WebM/EBML)"
command -v ffprobe >/dev/null && ffprobe -hide_banner "$OUT" 2>&1 | grep -E 'Input|Stream' || true
