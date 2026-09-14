#!/usr/bin/env node
// Build the reader-host bundle — for the platforms that have a reader host, and no others.
//
// The host exists to answer ONE measured defect: WebKitGTK does not deliver input into an iframe
// sandboxed `allow-same-origin` without `allow-scripts`, and Blink does. Windows has no such defect
// and never registers the origin (see the cfg in src-tauri/src/lib.rs), so shipping the bundle there
// would put the whole reader engine into the Windows artifact a second time, unreachable.
//
// WHY THE DEFAULT IS TO BUILD IT. `TAURI_ENV_PLATFORM` is set by the Tauri CLI for beforeBuildCommand
// and by nothing else, so a bare `npm run build` — CI's typecheck, the production-build gate, a
// developer checking their work — has no target and gets the bundle. That is deliberate: the default
// should be the one that COMPILES the code, so a break in the host entry is caught by any ordinary
// build rather than only by whoever next builds for Linux. Only an explicit Windows target skips it.
import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const OUT = join(ROOT, "dist", "reader-host");
const platform = process.env.TAURI_ENV_PLATFORM ?? "";

if (platform === "windows") {
  // REMOVE THE WHOLE DIRECTORY, not just the bundle this script would have written.
  //
  // Two reasons it is a deletion rather than a skip. First, `dist/` is not emptied between builds, so
  // a bundle left by an earlier non-Windows build would otherwise be embedded in the Windows binary —
  // the exact outcome this script exists to prevent, and one that would look like it had worked.
  // Second, the host's document and its self-check arrive from `public/`, which Vite copies
  // wholesale; skipping only the bundle would still ship the host's HTML in an artifact that
  // registers no origin to serve it. Nothing here is reachable on Windows, so nothing here ships.
  if (existsSync(OUT)) {
    rmSync(OUT, { recursive: true, force: true });
    console.log("[reader-host] removed dist/reader-host — no origin serves it on this target");
  }
  console.log("[reader-host] target is windows — no reader host is registered there, nothing built");
  process.exit(0);
}

console.log(`[reader-host] building (target: ${platform || "unspecified"})`);

// Vite's own JS entry, run by the Node already running this — not `npx`. Node refuses to spawn a
// `.cmd` without a shell (the CVE-2024-27980 fix) and throws EINVAL, so the npx form fails on
// Windows exactly where this script is most often run; going through a shell to work around that
// would mean quoting a path that can contain spaces. This has neither problem.
const VITE = join(ROOT, "node_modules", "vite", "bin", "vite.js");
if (!existsSync(VITE)) {
  console.error(`[reader-host] vite not found at ${VITE} — run \`npm ci\` first`);
  process.exit(1);
}
execFileSync(process.execPath, [VITE, "build"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, SARD_BUILD_TARGET: "reader-host" },
});
