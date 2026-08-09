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
python3 "$ROOT/probe/collector.py" "$OUT" 8792 >"$OUT/collector.log" 2>&1 &
COL=$!
sleep 1
curl -fsS -X POST --data '{"stage":"selftest"}' http://127.0.0.1:8792/report && echo "  collector answered its own self-test"
echo "::endgroup::"

echo "::group::build the frontend bundle"
( cd "$ROOT" && npm run build >"$OUT/vite.log" 2>&1 ) || { echo "vite build failed"; tail -20 "$OUT/vite.log"; exit 2; }
for f in reader-host/index.html reader-host/host.js fonts/Amiri-Regular.ttf foliate-js/vendor/pdfjs/cmaps/UniJIS-UCS2-H.bcmap __probe/index.html; do
  [[ -f "$ROOT/dist/$f" ]] && echo "  bundled: $f" || { echo "  MISSING: $f"; exit 2; }
done
echo "::endgroup::"

echo "::group::build the binary BEFORE timing anything — RELEASE, and that is the whole point"
# WHY RELEASE. This is the bug that produced four empty runs. A DEBUG build makes Tauri load
# `build.devUrl` (http://localhost:1420) instead of `build.frontendDist`, and the last run proves it:
#   px_manager_get_proxies_sync: url=http://localhost:1420 online=1
# No Vite server was listening, so every window — main and probe alike — opened onto nothing. The GTK
# window existed, which is what xdotool kept reporting, while no document ever loaded. Adding more
# reporting channels inside a page that was never fetched could not have worked.
#
# Serving dist/ on port 1420 would start the page, but it would ALSO move it to an http origin with
# whatever CSP that server sends — and origin behaviour and CSP enforcement are precisely what this
# probe measures. A release build is the only configuration that exercises the real asset protocol,
# the real origin and the real policy, so it is the only one whose result means anything.
#
# The previous run also spent 125 s of a 240 s budget compiling and was then killed with rc=124.
# Building before anything is timed means the timeout below measures runtime and nothing else.
( cd "$ROOT/src-tauri" && cargo build --release --locked ) >"$OUT/build.log" 2>&1 || {
  echo "cargo build failed"; tail -30 "$OUT/build.log"; exit 2; }
BIN="$ROOT/src-tauri/target/release/sard"
[[ -x "$BIN" ]] || { echo "no release binary at $BIN"; exit 2; }
echo "  built: $(stat -c%s "$BIN") bytes"
echo "::endgroup::"

echo "::group::run the real app under Xvfb"
export DISPLAY=":99"
Xvfb :99 -screen 0 1400x1000x24 >"$OUT/xvfb.log" 2>&1 &
sleep 2
export SARD_PROBE=1
export SARD_PROBE_OUT="$OUT/step1-runtime.json"
export SARD_PROBE_CORS="http://127.0.0.1:$PC"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
# WebKitGTK failures live in the web process, which says nothing on stdout unless asked. The DRI3 /
# libEGL warnings in the last run mean rendering is on the software path, where a web-process crash
# is a real possibility and would look exactly like "the script did not run".
export G_MESSAGES_DEBUG=all
export WEBKIT_DISABLE_DMABUF_RENDERER=1
rm -f "$SARD_PROBE_OUT"
# stdbuf: Rust block-buffers stdout when it is a pipe, which is why the last run's `[probe]` lines
# all appeared at exit. Line buffering makes the beacon observable while the app is still alive.
( cd "$ROOT/src-tauri" && timeout 120 stdbuf -oL -eL "$BIN" ) >"$OUT/app.log" 2>&1 &
APP=$!
# The window title carries the probe's stage, so a stall or a rejected invoke is visible rather
# than silent — the previous attempt produced no output at all and no reason for it.
LASTALL=""; LASTLOG=0
for _ in $(seq 1 130); do
  ALL="$(xdotool search --name . getwindowname %@ 2>/dev/null | tr '
' '|')"
  [[ -n "$ALL" && "$ALL" != "$LASTALL" ]] && { echo "  windows: $ALL"; LASTALL="$ALL"; echo "$ALL" >> "$OUT/titles.log"; }
  # Stream the app's new stdout as it happens. The beacon line proves the web process is alive, and
  # seeing it live distinguishes "never rendered" from "rendered, then died".
  NOW=$(wc -l <"$OUT/app.log" 2>/dev/null || echo 0)
  if (( NOW > LASTLOG )); then sed -n "$((LASTLOG+1)),${NOW}p" "$OUT/app.log" | sed 's/^/  app| /'; LASTLOG=$NOW; fi
  [[ -f "$SARD_PROBE_OUT" ]] && break
  kill -0 "$APP" 2>/dev/null || break
  sleep 1
done
wait "$APP" 2>/dev/null
echo "  app exited rc=$?"
echo "::endgroup::"

echo "=== CONFIGURATION GUARD: is the app loading the bundle or the dev server? ==="
if grep -q "localhost:1420" "$OUT/app.log" 2>/dev/null; then
  echo "  *** STILL POINTING AT devUrl — the result below is meaningless. ***"
  grep -m3 "localhost:1420" "$OUT/app.log" | sed 's/^/    /'
else
  echo "  no devUrl traffic — the app is serving from its embedded bundle"
fi

echo "=== LIVENESS: did the WebKit web process fetch anything? ==="
if grep -q "\[probe\] sardhost <-" "$OUT/app.log" 2>/dev/null; then
  echo "  YES — the renderer requested:"; grep "\[probe\] sardhost <-" "$OUT/app.log" | sed 's/^/    /'
  echo "  => the web process runs. A silent page is therefore a SCRIPT failure, not a dead renderer."
else
  echo "  NO — not one subresource was requested by the renderer."
  echo "  => the web process never rendered the page. No amount of in-page reporting can help."
fi

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
