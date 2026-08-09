#!/usr/bin/env bash
# Step 1 runtime probe — THROWAWAY. Runs the REAL Tauri app on real WebKitGTK under Xvfb and
# exercises the production bookhost handler.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/probe/out"; mkdir -p "$OUT"
PC="${PC:-8791}"

cleanup(){ for p in ${SC:-} ${COL:-}; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

echo "::group::permissive third origin (negative control)"
python3 - "$PC" >"$OUT/cors.log" 2>&1 <<'PY' &
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        body = b"pong"
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)
    def log_message(self, *a): pass
ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
PY
SC=$!
sleep 1
curl -fsS "http://127.0.0.1:$PC/ping" && echo "  third origin reachable (sends ACAO:*)"
echo "::endgroup::"


echo "::group::collector (persists every stage as it happens)"
python3 - "$OUT" >"$OUT/collector.log" 2>&1 <<'PY2' &
import sys, os, json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
OUT = sys.argv[1]; n = [0]
class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        n[0] += 1
        # Every stage is persisted the moment it arrives, so a later crash cannot erase it.
        open(os.path.join(OUT, "latest.json"), "wb").write(body)
        open(os.path.join(OUT, "stages.log"), "a", encoding="utf-8").write(
            "%03d %s
" % (n[0], (json.loads(body).get("stage") if body else "?")))
        self.send_response(200); self._cors(); self.send_header("Content-Length", "2"); self.end_headers()
        self.wfile.write(b"ok")
    def log_message(self, *a): pass
ThreadingHTTPServer(("127.0.0.1", 8792), H).serve_forever()
PY2
COL=$!
sleep 1
echo "  collector on :8792"
echo "::endgroup::"

echo "::group::build the frontend bundle"
( cd "$ROOT" && npm run build >"$OUT/vite.log" 2>&1 ) || { echo "vite build failed"; tail -20 "$OUT/vite.log"; exit 2; }
for f in reader-host/index.html reader-host/host.js fonts/Amiri-Regular.ttf foliate-js/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap __probe/index.html; do
  [[ -f "$ROOT/dist/$f" ]] && echo "  bundled: $f" || { echo "  MISSING: $f"; exit 2; }
done
echo "::endgroup::"

echo "::group::run the real app under Xvfb"
export DISPLAY=":99"
Xvfb :99 -screen 0 1400x1000x24 >"$OUT/xvfb.log" 2>&1 &
sleep 2
export SARD_PROBE=1
export SARD_PROBE_OUT="$OUT/step1-runtime.json"
export SARD_PROBE_CORS="http://127.0.0.1:$PC"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
rm -f "$SARD_PROBE_OUT"
( cd "$ROOT/src-tauri" && timeout 240 cargo run --locked ) >"$OUT/app.log" 2>&1 &
APP=$!
# The window title carries the probe's stage, so a stall or a rejected invoke is visible rather
# than silent — the previous attempt produced no output at all and no reason for it.
LAST=""; LASTALL=""
for _ in $(seq 1 220); do
  ALL="$(xdotool search --name . getwindowname %@ 2>/dev/null | tr '
' '|')"
  [[ -n "$ALL" && "$ALL" != "$LASTALL" ]] && { echo "  windows: $ALL"; LASTALL="$ALL"; echo "$ALL" >> "$OUT/titles.log"; }
  T="$(xdotool search --name "^PROBE" getwindowname %@ 2>/dev/null | tail -1)"
  [[ -n "$T" && "$T" != "$LAST" ]] && { echo "  title: $T"; LAST="$T"; echo "$T" >> "$OUT/titles.log"; }
  [[ -f "$SARD_PROBE_OUT" ]] && break
  kill -0 "$APP" 2>/dev/null || break
  sleep 1
done
wait "$APP" 2>/dev/null
echo "  app exited rc=$?"
tail -20 "$OUT/app.log"
echo "::endgroup::"

echo "=== stages received by the collector ==="; cat "$OUT/stages.log" 2>/dev/null || echo "  (none)"
if [[ ! -f "$SARD_PROBE_OUT" && -f "$OUT/latest.json" ]]; then
  echo "  IPC produced nothing; using the collector's last persisted stage"
  cp "$OUT/latest.json" "$SARD_PROBE_OUT"
fi
if [[ -f "$SARD_PROBE_OUT" ]]; then
  python3 "$ROOT/probe/step1-report.py" "$SARD_PROBE_OUT" | tee "$OUT/STEP1.md"
else
  echo "# Step 1 runtime probe" | tee "$OUT/STEP1.md"
  echo >> "$OUT/STEP1.md"
  echo "**No result file was produced — every runtime criterion is UNKNOWN.**" | tee -a "$OUT/STEP1.md"
  echo '```' >> "$OUT/STEP1.md"; tail -40 "$OUT/app.log" >> "$OUT/STEP1.md"; echo '```' >> "$OUT/STEP1.md"
  exit 1
fi
