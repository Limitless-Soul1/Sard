#!/usr/bin/env bash
# The reader-host RUNTIME GATE — THROWAWAY. Drives a real EPUB through the mounted host inside the
# real Tauri app on real WebKitGTK, then delivers a genuine X11 click and reads what arrived.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/probe/out"; mkdir -p "$OUT"

cleanup(){ for p in ${COL:-}; do kill "$p" 2>/dev/null; done; }
trap cleanup EXIT

echo "::group::collector"
python3 "$ROOT/probe/collector.py" "$OUT" 8792 >"$OUT/collector.log" 2>&1 &
COL=$!
sleep 1
curl -fsS -X POST --data '{"stage":"selftest"}' http://127.0.0.1:8792/report && echo "  collector answered its own self-test"
echo "::endgroup::"

echo "::group::subject"
npm run fixtures:build >"$OUT/fixtures.log" 2>&1 || { echo "fixtures failed"; tail -20 "$OUT/fixtures.log"; exit 2; }
node "$ROOT/probe/make-subject.mjs" || exit 2
echo "::endgroup::"

echo "::group::build (Tauri CLI — the only thing that embeds frontendDist rather than devUrl)"
( cd "$ROOT" && npx tauri build --no-bundle ) >"$OUT/build.log" 2>&1 || {
  echo "tauri build failed"; tail -40 "$OUT/build.log"; exit 2; }
BIN="$ROOT/src-tauri/target/release/sard"
[[ -x "$BIN" ]] || { echo "no binary at $BIN"; exit 2; }
for f in reader-host/bundle.js reader-host/index.html reader-host/host.js __probe/book.epub; do
  [[ -f "$ROOT/dist/$f" ]] && echo "  bundled: $f ($(stat -c%s "$ROOT/dist/$f") bytes)" || { echo "  MISSING: $f"; exit 2; }
done
echo "::endgroup::"

echo "::group::run"
export DISPLAY=":99"
Xvfb :99 -screen 0 1400x1000x24 >"$OUT/xvfb.log" 2>&1 &
sleep 2
export SARD_PROBE=1
export SARD_PROBE_OUT="$OUT/transport.json"
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
rm -f "$SARD_PROBE_OUT"
( cd "$ROOT/src-tauri" && timeout 180 stdbuf -oL -eL "$BIN" ) >"$OUT/app.log" 2>&1 &
APP=$!

CLICKED=0; LASTLOG=0
for _ in $(seq 1 175); do
  NOW=$(wc -l <"$OUT/app.log" 2>/dev/null || echo 0)
  if (( NOW > LASTLOG )); then sed -n "$((LASTLOG+1)),${NOW}p" "$OUT/app.log" | sed 's/^/  app| /'; LASTLOG=$NOW; fi

  # THE CLICK. Delivered by the X server to whatever is under the pointer — not dispatchEvent, not a
  # synthetic CDP event. The measured defect is in DELIVERY into a script-disabled frame, so only a
  # real one can falsify it. Fired once the page says the book is on screen and the counters armed.
  if (( CLICKED == 0 )) && grep -q "ready-for-click" "$OUT/stages.log" 2>/dev/null; then
    WID="$(xdotool search --name "^Sard$" | tail -1)"
    [[ -n "$WID" ]] && xdotool windowactivate --sync "$WID" 2>/dev/null
    sleep 1
    echo "  >>> delivering a real X11 click at (700,500) and a drag for selection"
    xdotool mousemove 700 500 click 1
    sleep 1
    # A drag too: selection is the interaction most likely to expose a delivery gap that a single
    # click would not, because it needs the whole pointerdown/move/up sequence to arrive in order.
    xdotool mousemove 500 480 mousedown 1 mousemove 900 520 mouseup 1
    CLICKED=1
  fi

  [[ -f "$SARD_PROBE_OUT" ]] && break
  kill -0 "$APP" 2>/dev/null || break
  sleep 1
done
wait "$APP" 2>/dev/null
echo "  app exited rc=$?"
echo "::endgroup::"

echo "=== configuration guard ==="
if grep -q "localhost:1420" "$OUT/app.log" 2>/dev/null; then
  echo "  *** loading devUrl — every result below is meaningless ***"
else
  echo "  serving from the embedded bundle"
fi

echo "=== what the host origin was asked for ==="
grep "\[probe\] sardhost <-" "$OUT/app.log" 2>/dev/null | sed 's/^/  /' | head -30 || echo "  (nothing — the renderer never fetched from the host)"

echo "=== stages ==="; cat "$OUT/stages.log" 2>/dev/null || echo "  (none)"

if [[ ! -f "$SARD_PROBE_OUT" && -f "$OUT/latest.json" ]]; then
  echo "  IPC produced nothing; using the collector's last persisted stage"
  cp "$OUT/latest.json" "$SARD_PROBE_OUT"
fi
if [[ -f "$SARD_PROBE_OUT" ]]; then
  python3 "$ROOT/probe/transport-report.py" "$SARD_PROBE_OUT" | tee "$OUT/GATE.md"
else
  echo "# Reader-host runtime gate" | tee "$OUT/GATE.md"
  echo >> "$OUT/GATE.md"
  echo "**No result file. Every runtime criterion is UNKNOWN.**" | tee -a "$OUT/GATE.md"
  echo '```' >> "$OUT/GATE.md"; tail -40 "$OUT/app.log" >> "$OUT/GATE.md"; echo '```' >> "$OUT/GATE.md"
  exit 1
fi
