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
# ONE build. The probe page is emitted by `npm run build` itself (scripts/build-probe.mjs, gated on
# SARD_BUILD_PROBE), which is the only point at which it lands in dist/ AND survives to be embedded:
# vite empties dist/ at the start of the Tauri build, and generate_context! reads it at the end.
( cd "$ROOT" && SARD_BUILD_PROBE=1 npx tauri build --no-bundle ) >"$OUT/build.log" 2>&1 || {
  echo "tauri build failed"; tail -40 "$OUT/build.log"; exit 2; }
BIN="$ROOT/src-tauri/target/release/sard"
[[ -x "$BIN" ]] || { echo "no binary at $BIN"; exit 2; }
for f in reader-host/bundle.js reader-host/index.html reader-host/host.js __probe/book.epub __probe/bundle.js; do
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
rm -f "$SARD_PROBE_OUT" "$OUT/clicked" "$OUT/stages.log"
( cd "$ROOT/src-tauri" && timeout 180 stdbuf -oL -eL "$BIN" ) >"$OUT/app.log" 2>&1 &
APP=$!

CLICKED=0; LASTLOG=0
for _ in $(seq 1 175); do
  NOW=$(wc -l <"$OUT/app.log" 2>/dev/null || echo 0)
  if (( NOW > LASTLOG )); then sed -n "$((LASTLOG+1)),${NOW}p" "$OUT/app.log" | sed 's/^/  app| /'; LASTLOG=$NOW; fi

  # THE CLICK. Delivered by the X server to whatever is under the pointer — not dispatchEvent, not a
  # synthetic CDP event. The measured defect is in DELIVERY into a script-disabled frame, so only a
  # real one can falsify it. Fired once the page says the book is on screen and the counters armed.
  if (( CLICKED == 0 )) && grep -qE "^[0-9]+ (opened|sync-read|keyboard)$" "$OUT/stages.log" 2>/dev/null; then
    # The PROBE window, not the main one. The probe page lives in a second window titled
    # sard-step1-probe; clicking the main "Sard" window would deliver a real event to a page that is
    # not under test and report zero, which is indistinguishable from the defect being measured.
    WID="$(xdotool search --name "sard-step1-probe" | tail -1)"
    if [[ -z "$WID" ]]; then
      echo "  !! probe window not found; windows are: $(xdotool search --name . getwindowname %@ 2>/dev/null | tr '
' '|')"
    else
      xdotool windowactivate --sync "$WID" 2>/dev/null
      xdotool windowraise "$WID" 2>/dev/null
      eval "$(xdotool getwindowgeometry --shell "$WID")"
      CX=$(( X + WIDTH / 2 )); CY=$(( Y + HEIGHT / 2 ))
      echo "  probe window ${WIDTH}x${HEIGHT} at ${X},${Y} — centre ${CX},${CY}"
      sleep 1
      echo "  >>> delivering a real X11 click at the centre of the book"
      xdotool mousemove "$CX" "$CY" click 1
      sleep 1
      # A drag too: selection needs the whole pointerdown/move/up sequence to arrive IN ORDER, so it
      # exposes a delivery gap a single click would not.
      xdotool mousemove $(( CX - 200 )) $(( CY - 20 )) mousedown 1               mousemove $(( CX + 200 )) $(( CY + 20 )) mouseup 1
      touch "$OUT/clicked"
    fi
    CLICKED=1
  fi

  # NOT `[[ -f $SARD_PROBE_OUT ]]`. probe_write rewrites that file on EVERY stage, so testing for its
  # existence broke this loop on the first emit — before the click was ever delivered — and the run
  # then reported "0 events arrived" for a click that never happened. Wait for the page to say it is
  # finished, or for the app to die.
  grep -q "^[0-9]* final$" "$OUT/stages.log" 2>/dev/null && break
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
  python3 "$ROOT/probe/transport-report.py" "$SARD_PROBE_OUT" "$OUT/clicked" | tee "$OUT/GATE.md"
else
  echo "# Reader-host runtime gate" | tee "$OUT/GATE.md"
  echo >> "$OUT/GATE.md"
  echo "**No result file. Every runtime criterion is UNKNOWN.**" | tee -a "$OUT/GATE.md"
  echo '```' >> "$OUT/GATE.md"; tail -40 "$OUT/app.log" >> "$OUT/GATE.md"; echo '```' >> "$OUT/GATE.md"
  exit 1
fi
