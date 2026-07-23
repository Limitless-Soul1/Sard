// Preflight for the test build (RAWY-TOOLING). A running Sard LOCKS its own exe, so either the release
// LINK/patch step (src-tauri/target/release/sard.exe) or the copy into test-build/ fails — historically
// with an obscure "Access is denied (os error 5)" / EBUSY buried deep in the build output, which reads as
// "the build is broken" rather than "close the app". Close every Sard FIRST, and if one refuses to die,
// ABORT LOUDLY with a clear instruction instead of letting the build fail cryptically further down.
//
// Covers ALL the names Sard runs under — a plain `taskkill /IM sard.exe` misses two of them:
//   • sard.exe            — the installed build + the release binary in target/release
//   • Sard.exe            — the test-build copy (test-build\Sard.exe)
//   • Sard-standalone.exe — the Share single-file, a DIFFERENT process name (SHARE-RELEASE.md gotcha)
import { execSync } from "node:child_process";

if (process.platform !== "win32") process.exit(0);

const NAMES = ["sard.exe", "Sard.exe", "Sard-standalone.exe"];
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const running = () => {
  try {
    const out = execSync("tasklist /fo csv /nh", { encoding: "utf8" }).toLowerCase();
    return [...new Set(NAMES.filter((n) => out.includes(`"${n.toLowerCase()}"`)))];
  } catch {
    return []; // tasklist unavailable → don't block the build
  }
};

let live = running();
if (live.length) {
  console.log(`[Sard] Closing running Sard before the test build: ${live.join(", ")}`);
  for (const n of NAMES) {
    try { execSync(`taskkill /IM ${n} /F`, { stdio: "ignore" }); } catch { /* not running */ }
  }
  sleep(700); // let Windows release the exe handle before the linker/patch/copy touches it
  live = running();
}

if (live.length) {
  console.error(
    `\n[Sard] TEST BUILD ABORTED — Sard is still running: ${live.join(", ")}.\n` +
    `Close every Sard window (including "Sard-standalone.exe" — a DIFFERENT process name than "sard"),\n` +
    `then re-run  npm run build:test .\n` +
    `A running copy locks its exe, so the build would otherwise die with a cryptic "Access is denied (os error 5)".`,
  );
  process.exit(1);
}

console.log("[Sard] No Sard running — proceeding with the test build.");
