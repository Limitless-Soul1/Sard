#!/usr/bin/env bash
# Step 1 runtime probe — THROWAWAY. Runs the REAL Tauri app on real WebKitGTK under Xvfb and
# exercises the production bookhost handler.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/probe/out"; mkdir -p "$OUT"
PC="${PC:-8791}"

cleanup(){ [[ -n "${SC:-}" ]] && kill "$SC" 2>/dev/null; }
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
( cd "$ROOT/src-tauri" && timeout 240 cargo run --locked ) >"$OUT/app.log" 2>&1
echo "  app exited rc=$?"
tail -20 "$OUT/app.log"
echo "::endgroup::"

if [[ -f "$SARD_PROBE_OUT" ]]; then
  python3 "$ROOT/probe/step1-report.py" "$SARD_PROBE_OUT" | tee "$OUT/STEP1.md"
else
  echo "# Step 1 runtime probe" | tee "$OUT/STEP1.md"
  echo >> "$OUT/STEP1.md"
  echo "**No result file was produced — every runtime criterion is UNKNOWN.**" | tee -a "$OUT/STEP1.md"
  echo '```' >> "$OUT/STEP1.md"; tail -40 "$OUT/app.log" >> "$OUT/STEP1.md"; echo '```' >> "$OUT/STEP1.md"
  exit 1
fi
