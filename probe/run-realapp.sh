#!/usr/bin/env bash
# DIAGNOSTIC — throwaway. Drives the REAL Sard application on real WebKitGTK and records what the
# reader actually does, because every gate that measures the transport has passed while the product
# is blank on a real machine.
#
# This opens a book the way a person does: the library is seeded with one real EPUB before the window
# appears, and the book card is clicked with a genuine X11 click. Nothing about the reader is
# simulated — it is Reader.tsx, the real transport and the real host.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; OUT="$ROOT/probe/out"; mkdir -p "$OUT"

echo "::group::subject + build"
npm run fixtures:build >"$OUT/fixtures.log" 2>&1 || { echo "fixtures failed"; exit 2; }
node "$ROOT/probe/make-subject.mjs" || exit 2
( cd "$ROOT" && SARD_BUILD_PROBE=1 npx tauri build --no-bundle ) >"$OUT/build.log" 2>&1 || {
  echo "build failed"; tail -40 "$OUT/build.log"; exit 2; }
BIN="$ROOT/src-tauri/target/release/sard"
[[ -x "$BIN" ]] || { echo "no binary"; exit 2; }
echo "::endgroup::"

echo "::group::run the real application"
export DISPLAY=":99"
Xvfb :99 -screen 0 1400x1000x24 >"$OUT/xvfb.log" 2>&1 &
sleep 2
# A FRESH PROFILE. The library must contain exactly the seeded book, so the click below is
# unambiguous and the run is repeatable.
rm -rf "$HOME/.local/share/com.sard.app"
export SARD_SEED_BOOK=1
export WEBKIT_DISABLE_COMPOSITING_MODE=1
export WEBKIT_DISABLE_DMABUF_RENDERER=1
( cd "$ROOT/src-tauri" && timeout 150 stdbuf -oL -eL "$BIN" ) >"$OUT/app.log" 2>&1 &
APP=$!

CLICKED=0; LASTLOG=0
for _ in $(seq 1 145); do
  NOW=$(wc -l <"$OUT/app.log" 2>/dev/null || echo 0)
  if (( NOW > LASTLOG )); then sed -n "$((LASTLOG+1)),${NOW}p" "$OUT/app.log" | grep -E "^\[trace\]|panic|ERROR" | sed 's/^/  /'; LASTLOG=$NOW; fi

  if (( CLICKED == 0 )) && grep -q "seeded library" "$OUT/app.log" 2>/dev/null; then
    WID="$(xdotool search --name "^Sard$" | tail -1)"
    if [[ -n "$WID" ]]; then
      xdotool windowactivate --sync "$WID" 2>/dev/null; xdotool windowraise "$WID" 2>/dev/null
      sleep 6   # let the library render its grid
      import -window root png24:"$OUT/01-library.png" 2>/dev/null
      eval "$(xdotool getwindowgeometry --shell "$WID")"
      # The first book card sits in the upper-left of the grid in LTR and upper-right in RTL; the
      # library defaults to the UI language, so both are clicked in turn. A click on empty desk does
      # nothing, so trying both is harmless.
      # The library is RTL (ui_lang=ar is seeded), so the first card is on the RIGHT. Both sides are
      # tried anyway: a click on empty desk does nothing, and guessing wrong once already cost a run.
      echo "  >>> clicking the first book card"
      # Coordinates read off a captured screenshot of the real library, not guessed: the sidebar
      # occupies the right ~230px in RTL and the first card sits just left of it, centred near
      # (WIDTH-350, 280). The first attempt clicked WIDTH-200, which is inside the sidebar.
      for POS in "$(( X + WIDTH - 350 )) $(( Y + 280 ))" "$(( X + WIDTH - 350 )) $(( Y + 200 ))"                  "$(( X + WIDTH - 250 )) $(( Y + 280 ))" "$(( X + WIDTH - 450 )) $(( Y + 280 ))"; do
        grep -q "OPEN     called" "$OUT/app.log" 2>/dev/null && break
        # shellcheck disable=SC2086
        xdotool mousemove $POS click 1
        sleep 3
      done
      import -window root png24:"$OUT/01b-afterclick.png" 2>/dev/null
      CLICKED=1
    fi
  fi

  if (( CLICKED == 1 )) && grep -q "APP      after open\|TIMEOUT\|host.open done\|host.open THREW" "$OUT/app.log" 2>/dev/null; then
    sleep 6
    import -window root png24:"$OUT/02-reader.png" 2>/dev/null
    break
  fi
  kill -0 "$APP" 2>/dev/null || break
  sleep 1
done
sleep 2
import -window root png24:"$OUT/03-final.png" 2>/dev/null
kill "$APP" 2>/dev/null; wait "$APP" 2>/dev/null
echo "::endgroup::"

echo "=== LIFECYCLE TRACE ==="
grep -E "^\[trace\]" "$OUT/app.log" | sed 's/^\[trace\] //' || echo "  (no trace lines at all)"

echo
echo "=== ERRORS / PANICS ==="
grep -iE "panic|uncaught|unhandled|refused|denied|SecurityError|DataClone" "$OUT/app.log" | head -20 || echo "  none"

echo
echo "=== PIXELS: is the reading area blank? ==="
python3 "$ROOT/probe/pixels.py" "$OUT/02-reader.png" "$OUT/03-final.png" 2>&1 || echo "  (pixel analysis unavailable)"
