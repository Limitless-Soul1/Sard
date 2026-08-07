// WP-0 (RESILIENCE-1) — a minimal CDP client for driving the REAL Sard binary.
//
// WHY THE REAL BINARY. Every question this harness exists to answer — "did this book's rendering
// change?" — is a question about WebView2's layout engine running Sard's actual injected CSS
// against foliate's actual pagination. jsdom cannot answer it and a mock cannot either. The debug
// port is the project's sanctioned measurement route (D55): it opens ONLY when the launching
// process sets WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, that string appears in zero shipped
// artifacts, and it is kept deliberately because it is the only way to measure a real release build.
//
// No dependency: Node >= 22 ships a global WebSocket, which is all CDP needs.

import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/** Poll the DevTools HTTP endpoint until a page target appears, or give up. */
async function waitForTarget(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page;
      lastErr = new Error(`no page target among ${targets.length} target(s)`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(250);
  }
  throw new Error(`CDP target never appeared on port ${port}: ${lastErr?.message ?? "timed out"}`);
}

/**
 * Launch Sard with the debug port open and return a session.
 *
 * ⚠ This drives the app against its REAL app-data directory (%APPDATA%\com.sard.app). Tauri
 * resolves that from the bundle identifier with no environment override, so there is no isolated
 * profile to point it at. Callers that do anything beyond reading MUST snapshot the database first
 * — see snapshotDb() in byte-identity.mjs and the project's own `.db-snapshot-*` convention.
 */
/**
 * Kill every Sard process on the machine, synchronously.
 *
 * Used BEFORE a launch (so a run can never share the profile with a survivor from a previous run)
 * and AFTER a close (so a run can never leave one behind). Two of this milestone's profile
 * corruptions were caused by two instances holding the same sqlite file, one of them a stray.
 */
export function forceKillAll() {
  try {
    // /T also takes any WebView2 children, which keep file handles open on their own.
    execFileSync("taskkill", ["/IM", "Sard.exe", "/F", "/T"], { stdio: "ignore" });
  } catch {
    /* exit code 128 = "no such process", which is the state we want anyway */
  }
}

/** Is any Sard process alive right now? The post-condition every harness run must satisfy. */
export function anySardRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq Sard.exe", "/NH"], { encoding: "utf8" });
    return /Sard\.exe/i.test(out);
  } catch {
    return false;
  }
}

export async function launchSard({ exe = "test-build/Sard.exe", port = 9333, timeoutMs = 30_000 } = {}) {
  if (!existsSync(exe)) {
    return { skipped: `no binary at ${exe} — run \`npm run build:test\` first` };
  }
  // GUARANTEE A SINGLE INSTANCE. A survivor from an earlier run shares the same real profile, and
  // whichever process exits last writes its stale in-memory settings over the other's.
  forceKillAll();
  await sleep(300);
  const child = spawn(exe, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
    stdio: "ignore",
    detached: false,
  });

  let page;
  try {
    page = await waitForTarget(port, timeoutMs);
  } catch (e) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    throw e;
  }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return; // an event, not a reply
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
    else p.resolve(msg.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`CDP ${method} timed out`));
      }, 20_000);
    });

  /** Evaluate an expression in the page and return its value. Throws on a JS exception. */
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page threw: ${d.exception?.description ?? d.text}`);
    }
    return r.result?.value;
  };

  /**
   * Close the app and DO NOT RETURN UNTIL IT HAS ACTUALLY EXITED.
   *
   * This used to be `child.kill()` followed by a fixed 500 ms sleep, and that single line is the
   * root cause of every profile corruption this milestone hit. A dying Sard still holds sqlite open,
   * so a restore that began during those 500 ms raced a live writer: measured damage included a
   * leaked `flowMode`, `hide_chapter_titles` left on, and the owner's real typography (`zoom`,
   * `lineHeight`, `paragraphSpacing`) overwritten by a second instance's stale in-memory state.
   * Byte-identity then reported 1,517 / 978 / 54 "rendering differences" that were none of them real.
   *
   * A timeout is not a synchronisation primitive. This waits for the OS to confirm the exit, then
   * escalates, then verifies that no Sard process is left anywhere — because a stray instance is how
   * two of those incidents began.
   */
  const close = async () => {
    try { ws.close(); } catch { /* already gone */ }
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      try { child.kill(); } catch { /* already gone */ }
      // Wait for the real exit; escalate to a forced kill if it does not come.
      const won = await Promise.race([exited, sleep(6000).then(() => "timeout")]);
      if (won === "timeout") {
        forceKillAll();
        await Promise.race([exited, sleep(4000)]);
      }
    }
    // Belt and braces: nothing named Sard may survive this call, whoever started it.
    forceKillAll();
    // The file handles are released a beat after the process record disappears; without this a
    // following `npm run build:test` fails with "Access is denied (os error 5)".
    await sleep(400);
  };

  return { send, evaluate, close, pid: child.pid, target: page.title };
}
