// PPC-1 — DOES THE SANITISER COVER AN INLINE <style> BLOCK AND A style= ATTRIBUTE?
//
// Filed as code-derived only: `epub.js` routes `<style>` text (line 856) and `style=` attributes
// (line 859) through the same `replaceCSS` where the Sard hook lives (LOCAL PATCH 5), so it *should*
// apply — but every hostile fixture to date used an EXTERNAL stylesheet, so it was never observed at
// runtime. This closes it with a measurement.
//
// THE DESIGN THAT MAKES THE RESULT MEAN SOMETHING. Three things are measured, not one:
//
//   raw        the hostile declarations MUST take effect. Without this the whole run is worthless:
//              "nothing hostile survived" is indistinguishable from "the CSS never loaded, the
//              selector matched nothing, or the fixture is broken". This is the potency control.
//   sanitised  the hostile declarations must be GONE and the benign ones must SURVIVE. Benign
//              survival is what separates "the sanitiser worked" from "book CSS was dropped whole".
//
// The reading is done from getComputedStyle inside the live section document, which is the only
// place that reflects what the reader can actually see.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = [];
const ok = (n, c, d = "") => { console.log(`   ${c ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`); if (!c) fail.push(n); };
const FIXTURE = join(import.meta.dirname, "..", "fixtures", "epub", "hostile-inline-style.epub");

const snap = snapshotDb("M:\\eRawy", "ppc1");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }
let s = null;
// RETRIES ON A FRESH PORT. Repeated launch/kill cycles intermittently leave a debug port unusable
// for a while — the run before this one got two clean measurements and then failed to launch a third,
// which also killed the CLEANUP that had to run afterwards. Losing a measurement is a nuisance;
// losing the cleanup leaves a fixture book in the owner's real library, which happened three times.
// So launching is made to survive a bad port instead of the whole run depending on one.
const launch = async (port) => {
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const sess = await launchSard({ exe: "test-build/Sard.exe", port: port + attempt * 7, timeoutMs: 60_000 });
      if (sess.skipped) throw new Error(sess.skipped);
      for (let i = 0; i < 150; i++) {
        if (await sess.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
        await sleep(400);
      }
      await sleep(2000);
      return sess;
    } catch (e) {
      lastErr = e;
      console.log(`   (launch on ${port + attempt * 7} failed: ${e.message} — retrying)`);
      try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
      await sleep(3000);
    }
  }
  throw lastErr ?? new Error("launch failed");
};
const kill = async () => {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1800);
};

let importedId = null;
try {
  // ---- set up: import the fixture once -------------------------------------------------------
  //
  // The id is REMEMBERED so the book can be deleted again at the end. `library/` is censused but not
  // copied by the snapshot (it holds gigabytes of real books), so an import is NOT undone by
  // restoreDb: the first run of this harness left a fixture EPUB sitting in the owner's real library
  // and the restore could only report the drift, not repair it. A harness that needs a human to tidy
  // up after it is not finished.
  s = await launch(9490);
  const imported = await s.evaluate(`(async () => { try {
      return JSON.stringify(await window.__TAURI_INTERNALS__.invoke('import_books', { paths: [${JSON.stringify(FIXTURE)}] }));
    } catch (e) { return 'THREW: ' + e.message; } })()`);
  console.log("import:", String(imported).slice(0, 200));
  try { importedId = JSON.parse(imported)?.[0]?.id ?? null; } catch { /* left null */ }
  console.log("imported id:", importedId ?? "(unknown — will sweep by content hash at the end)");

  // The mode is read when a BOOK IS OPENED, not at app start, so setting it and then opening in the
  // same session is enough — one launch per mode rather than two. (Six launches was what exhausted
  // the debug ports on the first run.) The value is read back after the open and printed, so a mode
  // that failed to stick is visible rather than silently measured as something else.
  const measure = async (mode, port) => {
    await kill();
    s = await launch(port);
    await s.evaluate(
      `(async () => window.__TAURI_INTERNALS__.invoke('settings_set', ` +
      `{ key: 'book_css', value: ${JSON.stringify(mode)} }))()`,
    );
    await sleep(1000);
    for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
    const opened = await s.evaluate(`(() => {
      const c = [...document.querySelectorAll('.lib-card')].find(x => /Well-Formed|hostile|inline/i.test(x.textContent || '')) || document.querySelector('.lib-card');
      if (c) c.click(); return !!c; })()`);
    if (!opened) throw new Error(`${mode}: no library card to open`);
    for (let i = 0; i < 100; i++) {
      if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) break;
      await sleep(300);
    }
    await sleep(3500);
    const readMode = await s.evaluate(`(async () => { try {
        return String(await window.__TAURI_INTERNALS__.invoke('settings_get', { key: 'book_css' })); } catch { return '?'; } })()`);
    const styles = await s.evaluate(`(() => {
      const d = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
      if (!d) return JSON.stringify({ error: 'no section document' });
      const para = d.querySelector('.para'), chap = d.querySelector('.chap');
      if (!para || !chap) return JSON.stringify({ error: 'selectors matched nothing: .para=' + !!para + ' .chap=' + !!chap });
      const p = getComputedStyle(para), h = getComputedStyle(chap);
      return JSON.stringify({
        // from the <style> BLOCK
        paraMarginTop: p.marginTop, paraMarginLeft: p.marginLeft, paraFontSize: p.fontSize,
        paraTextAlign: p.textAlign, paraFontStyle: p.fontStyle,
        chapPosition: h.position, chapFontWeight: h.fontWeight, chapLetterSpacing: h.letterSpacing,
        bodyColor: getComputedStyle(d.body).color,
        // from the style= ATTRIBUTE
        paraColor: p.color,
        hasStyleAttr: para.hasAttribute('style'),
        styleAttrText: para.getAttribute('style') || '',
      });
    })()`).then(JSON.parse);
    return { readMode, styles };
  };

  // ---- 1. RAW — the potency control ------------------------------------------------------------
  console.log("\n1. book_css = RAW — the hostile declarations MUST take effect (potency control)");
  const raw = await measure("raw", 9491);
  console.log("   mode read back:", raw.readMode, "\n   ", JSON.stringify(raw.styles));
  if (raw.styles.error) {
    ok("the raw run produced a measurable section", false, raw.styles.error);
  } else {
    // POTENCY IS ASSERTED ONLY ON PROPERTIES SARD DOES NOT ITSELF SET.
    //
    // The first version of this check tested `margin-top` and `color`, and both "failed" in raw mode
    // against a product that was behaving correctly: Sard's own injected typography owns paragraph
    // margin-top (paragraph spacing), and the theme's paint sheet owns colour so the page cannot be
    // recoloured out from under the reader. A book's declaration losing to Sard's is the design
    // working, not the fixture failing — but it makes those two useless as evidence that the book's
    // CSS reached the document at all. `position` and `margin-left` are untouched by Sard, so they
    // answer the question the control exists to answer.
    ok("RAW: the <style> block's position:absolute IS applied", raw.styles.chapPosition === "absolute",
       `position=${raw.styles.chapPosition}`);
    ok("RAW: the style= attribute's negative margin IS applied", parseFloat(raw.styles.paraMarginLeft) < 0,
       `margin-left=${raw.styles.paraMarginLeft} (-70pt = -93.3px)`);
    ok("RAW: the style= attribute survives intact on the element", /margin-left:\s*-70pt/.test(raw.styles.styleAttrText),
       `style="${raw.styles.styleAttrText}"`);
  }

  // ---- 2. SANITISED — the actual question -----------------------------------------------------
  console.log("\n2. book_css = SANITISED — hostile must be GONE, benign must SURVIVE");
  const san = await measure("sanitised", 9493);
  console.log("   mode read back:", san.readMode, "\n   ", JSON.stringify(san.styles));
  if (san.styles.error) {
    ok("the sanitised run produced a measurable section", false, san.styles.error);
  } else {
    ok("<style> BLOCK: the negative margin is gone", parseFloat(san.styles.paraMarginTop) >= 0, `margin-top=${san.styles.paraMarginTop}`);
    ok("<style> BLOCK: the negative left margin is gone", parseFloat(san.styles.paraMarginLeft) >= 0, `margin-left=${san.styles.paraMarginLeft}`);
    ok("<style> BLOCK: position:absolute is gone", san.styles.chapPosition !== "absolute", `position=${san.styles.chapPosition}`);
    ok("<style> BLOCK: the !important text-align is gone", san.styles.paraTextAlign !== "left", `text-align=${san.styles.paraTextAlign}`);
    ok("<style> BLOCK: the benign font-style SURVIVED", san.styles.paraFontStyle === "italic", `font-style=${san.styles.paraFontStyle}`);
    ok("<style> BLOCK: the benign font-weight SURVIVED", san.styles.chapFontWeight === "700", `font-weight=${san.styles.chapFontWeight}`);
    ok("style= ATTRIBUTE: the negative margin is gone", parseFloat(san.styles.paraMarginLeft) >= 0, `margin-left=${san.styles.paraMarginLeft}`);
    // THE DIRECT EVIDENCE for the attribute path, and the reason it is worth stating separately:
    // the attribute is not merely out-competed, it is REWRITTEN. Raw leaves it intact; sanitised
    // empties it. Nothing about specificity or cascade can produce that — only the hook.
    ok("style= ATTRIBUTE: the attribute itself was rewritten, not just outranked",
       san.styles.styleAttrText !== raw.styles.styleAttrText,
       `raw="${raw.styles.styleAttrText}"  ->  sanitised="${san.styles.styleAttrText}"`);
  }

  // `off` is deliberately NOT measured here. PPC-1 asks whether the SANITISER covers these two paths,
  // and `off` drops all book CSS regardless of path — it can neither confirm nor refute that. It is
  // the shipped default and is already covered by the WP-7 mode matrix. One launch fewer is also one
  // fewer chance of the run dying before its cleanup.
} catch (e) {
  console.error("\nHARNESS FAILED:", e.message);
  fail.push("harness: " + e.message);
} finally {
  // REMOVE THE IMPORTED FIXTURE, through the app's own delete so the row and the file go together.
  // Done BEFORE restoreDb, so the census the restore takes sees a library already back to normal.
  await kill();
  // CLEANUP MUST NOT NEED THE APP.
  //
  // The first version called `book_delete` over IPC, which meant launching Sard a fourth time in one
  // run — and it will not start a fourth time (measured: three consecutive failures across three
  // different debug ports). So cleanup died exactly when the run had already gone badly, and the
  // fixture was left in the owner's real library three times running.
  //
  // The DB row is not the problem: `restoreDb` puts the database back (verified — book count and
  // `book_css` both return to their prior values). The only orphan is the FILE, and Sard names library
  // files by their CONTENT HASH. So it can be removed directly, and — because the name IS the hash —
  // the removal can be PROVEN to target the fixture and nothing else. A user's book cannot be hit by
  // this even if the id were wrong.
  try {
    const libDir = join(process.env.APPDATA, "com.sard.app", "library");
    const want = createHash("sha256").update(readFileSync(FIXTURE)).digest("hex");
    const victim = join(libDir, `${want}.epub`);
    if (existsSync(victim)) {
      const actual = createHash("sha256").update(readFileSync(victim)).digest("hex");
      if (actual === want) {
        rmSync(victim);
        console.log(`\nfixture removed from the library (hash-verified ${want.slice(0, 16)}…)`);
      } else {
        console.error(`\nREFUSING TO DELETE ${victim} — its contents do not match the fixture.`);
      }
    }
  } catch (e) {
    console.error("\nCOULD NOT REMOVE THE FIXTURE FILE — do it by hand:", e.message);
  }
  console.log("\nprofile restored:", (await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY");
  console.log(fail.length === 0 ? "\nALL CHECKS PASSED" : `\n${fail.length} FAILED:\n  - ${fail.join("\n  - ")}`);
  process.exit(fail.length === 0 ? 0 : 1);
}
