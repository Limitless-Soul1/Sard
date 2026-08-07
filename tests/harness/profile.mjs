// RESILIENCE-1 — the REAL-PROFILE guard, shared by every harness that drives the real binary.
//
// Tauri resolves app data from the bundle identifier with no environment override, so there is no
// isolated profile to test against: opening a book in a harness writes the owner's reading progress,
// `last_opened_at`, `seen_start` and `chapters_read`. Every harness therefore snapshots the database
// before it starts and restores it on EVERY exit path, including a crash.
//
// This lived in three copies (byte-identity, tts-track, interaction) until one of them failed for
// real — and the copies are exactly why it is now one file. A guard that protects the owner's data
// must have a single implementation that can be made correct once.
//
// WHAT WENT WRONG, and what this fixes. A run ended, `sard.db` and `-wal` were copied back, then
// `-shm` threw EUNKNOWN because a still-exiting Sard process held it. The throw escaped the finally
// block, so the snapshot was never cleaned up AND the process was left running; the next run then
// snapshotted a profile that had already been half-restored. A restore that can fail halfway is
// worse than no restore. So: retry with a deadline, treat `-shm` as the special case it is, and if
// the restore genuinely cannot finish, KEEP the snapshot and say so loudly instead of exiting clean.

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { anySardRunning } from "./cdp.mjs"; // no cycle: cdp.mjs imports nothing from here

export const APP_DATA = join(process.env.APPDATA ?? "", "com.sard.app");

// Order matters: `-shm` is last because it is the one that may legitimately be dropped.
const DB_FILES = ["sard.db", "sard.db-wal", "sard.db-shm"];

// MANAGED FILES ARE PART OF THE PROFILE, AND THE HARNESS OWNS PUTTING THEM BACK.
//
// The database was never the whole of the user's state — covers, photo cards and backgrounds are
// FILES referenced by rows, which the project already records as "a database snapshot is no longer a
// full snapshot of user-visible state". Snapshotting only the DB therefore produced a restore that
// could not undo a deleted file, and on 2026-08-07 a cover stress test destroyed two of the owner's
// custom covers: the rows rolled back, the bytes could not, and the profile was left pointing at
// files that no longer existed. One of the two was recoverable only because an unrelated manual
// backup happened to exist.
//
// So these directories are copied and restored EXACTLY, deletions included. Preserving the owner's
// data is the harness's job, not the job of whoever remembers to be careful.
//
// `library/` itself (270 MB of books) and `voices/` (121 MB of models) are deliberately NOT copied:
// no harness mutates them, and paying that on every run would make the guard expensive enough that
// someone would eventually switch it off. They are covered by the census below instead, which is
// cheap and turns any damage there into a loud report rather than a silent loss.
const MANAGED_DIRS = ["library/covers", "photocards", "backgrounds", "fonts"];

/** Everything else under the profile, watched by name+size only — detection, not restoration. */
const CENSUS_DIRS = ["library", "voices"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every file under `root`, as `relative path -> size`. Missing directory = empty census. */
function census(root) {
  const out = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          out.set(relative(root, p), statSync(p).size);
        } catch {
          /* vanished mid-walk — the compare will report it */
        }
      }
    }
  };
  walk(root);
  return out;
}

/** Compare two censuses, returning human-readable differences (missing / added / resized). */
function censusDiff(before, after) {
  const diff = [];
  for (const [f, size] of before) {
    if (!after.has(f)) diff.push(`MISSING ${f}`);
    else if (after.get(f) !== size) diff.push(`CHANGED ${f} (${size} -> ${after.get(f)})`);
  }
  for (const f of after.keys()) if (!before.has(f)) diff.push(`ADDED ${f}`);
  return diff;
}

/** Copy the profile database aside. Throws rather than run unprotected. */
export function snapshotDb(repo, tag = "harness") {
  // NEVER SNAPSHOT WHILE SARD IS RUNNING.
  //
  // Measured 2026-08-05: `flowMode` leaked from the harness into the owner's real profile even
  // though every restore hash-verified and no snapshot was left behind. Neither the per-mode run nor
  // the cross-mode run leaked in isolation — only back-to-back runs did. The race: a restore is
  // verified the instant the copy lands, but a still-exiting app can flush its in-memory settings
  // afterwards; the NEXT run then snapshots that re-corrupted state and faithfully restores it, so
  // the corruption is laundered into "a verified restore" and survives forever.
  //
  // Refusing to snapshot while a Sard process is alive removes the second half of that race. Bounded
  // wait, then a hard failure — running without a trustworthy snapshot is the one thing worse than
  // not running at all.
  const deadline = Date.now() + 15_000;
  while (anySardRunning() && Date.now() < deadline) execFileSync("cmd", ["/c", "timeout", "/t", "1", "/nobreak"], { stdio: "ignore" });
  if (anySardRunning()) {
    throw new Error("a Sard process is still running — refusing to snapshot a profile that may still be written to");
  }

  const dir = join(repo, `.db-snapshot-${tag}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  let copied = 0;
  for (const f of DB_FILES) {
    const src = join(APP_DATA, f);
    if (existsSync(src)) {
      copyFileSync(src, join(dir, f));
      copied++;
    }
  }
  if (copied === 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`no database found at ${APP_DATA} — refusing to run without a snapshot`);
  }

  // Managed files, copied in full. A failure here is fatal for the same reason a missing database is:
  // a run that cannot be undone must not start.
  for (const rel of MANAGED_DIRS) {
    const src = join(APP_DATA, rel);
    if (!existsSync(src)) continue;
    try {
      cpSync(src, join(dir, "files", rel), { recursive: true });
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw new Error(`could not snapshot ${rel} (${e.message}) — refusing to run without a full snapshot`);
    }
  }

  // The census is written as data so `restoreDb` can compare against it without every harness having
  // to thread state through its own finally block.
  const c = {};
  for (const rel of CENSUS_DIRS) c[rel] = Object.fromEntries(census(join(APP_DATA, rel)));
  writeFileSync(join(dir, "census.json"), JSON.stringify(c));
  return dir;
}

/**
 * Put the profile back, retrying while the app lets go of its files.
 *
 * `-shm` is a DERIVED index that SQLite rebuilds from the WAL, so when it cannot be written it is
 * deleted instead — a stale `-shm` paired with a restored WAL is the one combination that would
 * actually be inconsistent. Anything else failing is reported and the snapshot is kept.
 */
/** SHA-256 of a file, or null when it does not exist. */
function hashOf(file) {
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Did the restore actually land?
 *
 * `sard.db` and `-wal` together carry every setting, so comparing them byte-for-byte against the
 * snapshot is a complete check — no per-setting list to keep in sync, and it cannot miss a field the
 * way the fingerprint's `config:` line missed `paragraphSpacing`. `-shm` is excluded deliberately:
 * it is a derived index SQLite rebuilds, so it legitimately differs.
 */
export function verifyRestored(dir) {
  const drift = [];
  for (const f of ["sard.db", "sard.db-wal"]) {
    const want = hashOf(join(dir, f));
    const got = hashOf(join(APP_DATA, f));
    if (want !== got) drift.push(f);
  }
  return drift;
}

export async function restoreDb(dir, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const failed = [];
  for (const f of DB_FILES) {
    const src = join(dir, f);
    const dst = join(APP_DATA, f);
    let done = false;
    while (!done && Date.now() < deadline) {
      try {
        if (existsSync(src)) copyFileSync(src, dst);
        else if (existsSync(dst)) rmSync(dst, { force: true });
        done = true;
      } catch {
        await sleep(400); // the app is still exiting
      }
    }
    if (!done) failed.push(f);
  }
  if (failed.includes("sard.db-shm")) {
    try {
      rmSync(join(APP_DATA, "sard.db-shm"), { force: true });
    } catch {
      /* SQLite rebuilds it on the next open */
    }
  }
  const fatal = failed.filter((f) => f !== "sard.db-shm");
  if (fatal.length) {
    console.error(`\n  ⚠ COULD NOT RESTORE ${fatal.join(", ")} — snapshot KEPT at ${dir}\n`);
    return false;
  }
  // VERIFY, then delete. A restore that silently did not land is exactly how four settings leaked
  // into the owner's profile during this milestone; keeping the snapshot is the only safe response.
  const drift = verifyRestored(dir);
  if (drift.length) {
    console.error(`\n  ⚠ RESTORE DID NOT LAND for ${drift.join(", ")} — snapshot KEPT at ${dir}\n`);
    return false;
  }
  // AND AGAIN AFTER A SETTLE. The check above only proves the copy landed — it runs microseconds
  // after the copy, so it cannot see a late writer. That blind spot is how `flowMode` leaked into
  // the owner's profile on 2026-08-05: verified, then quietly overwritten by an app still exiting.
  await sleep(2000);
  const late = verifyRestored(dir);
  if (late.length) {
    console.error(
      `\n  ⚠ PROFILE RE-CORRUPTED AFTER A VERIFIED RESTORE (${late.join(", ")}) — something is still ` +
        `writing. Snapshot KEPT at ${dir}; restore it by hand before trusting any measurement.\n`,
    );
    return false;
  }
  // MANAGED FILES — restored to EXACTLY the snapshot, deletions included.
  //
  // Copying the snapshot over the top is not enough: the failure that motivated this was a test
  // DELETING files, which a copy-over cannot undo. So anything present now and absent from the
  // snapshot is removed, and anything whose bytes differ is rewritten.
  const fileDrift = [];
  for (const rel of MANAGED_DIRS) {
    const snapDir = join(dir, "files", rel);
    const liveDir = join(APP_DATA, rel);
    if (!existsSync(snapDir) && !existsSync(liveDir)) continue;
    mkdirSync(liveDir, { recursive: true });
    const want = census(snapDir);
    const have = census(liveDir);
    for (const f of have.keys()) {
      if (!want.has(f)) {
        try {
          rmSync(join(liveDir, f), { force: true });
        } catch {
          fileDrift.push(`could not delete ${rel}/${f}`);
        }
      }
    }
    for (const [f, size] of want) {
      const dst = join(liveDir, f);
      if (have.get(f) === size && hashOf(dst) === hashOf(join(snapDir, f))) continue;
      try {
        mkdirSync(join(dst, ".."), { recursive: true });
        copyFileSync(join(snapDir, f), dst);
      } catch {
        fileDrift.push(`could not restore ${rel}/${f}`);
      }
    }
    // Prove it landed rather than assume it — the same discipline the database restore uses.
    const after = census(liveDir);
    for (const d of censusDiff(want, after)) fileDrift.push(`${rel}: ${d}`);
  }
  if (fileDrift.length) {
    console.error(
      `\n  ⚠ MANAGED FILES NOT RESTORED — snapshot KEPT at ${dir}\n` +
        fileDrift.map((d) => `      ${d}`).join("\n") + "\n",
    );
    return false;
  }

  // CENSUS — the directories too large to copy are watched, not restored. Damage there cannot be
  // undone automatically, so the one thing that must never happen is that it goes unnoticed.
  try {
    const snapCensus = JSON.parse(readFileSync(join(dir, "census.json"), "utf8"));
    const damage = [];
    for (const rel of CENSUS_DIRS) {
      const before = new Map(Object.entries(snapCensus[rel] ?? {}));
      for (const d of censusDiff(before, census(join(APP_DATA, rel)))) damage.push(`${rel}: ${d}`);
    }
    if (damage.length) {
      console.error(
        `\n  ⚠ THE PROFILE CHANGED OUTSIDE THE RESTORED SET — snapshot KEPT at ${dir}\n` +
          `      These files are watched but NOT copied, so this cannot be undone automatically:\n` +
          damage.slice(0, 20).map((d) => `      ${d}`).join("\n") + "\n",
      );
      return false;
    }
  } catch {
    /* no census (an older snapshot) — the database and managed files are still verified above */
  }

  rmSync(dir, { recursive: true, force: true });
  return true;
}
