// FULL-LIBRARY COMPATIBILITY AUDIT — every book, opened in the real binary, measured.
//
// THE TRIAGE PROBLEM, AND HOW THIS ANSWERS IT HONESTLY.
// "Is this Sard's fault or the book's?" cannot be settled here by opening the file in another reader
// — there isn't one on this machine. So the audit uses the strongest evidence that IS available: the
// book's OWN DECLARATIONS. An EPUB states its structure in the OPF spine and in its nav document or
// NCX. If Sard displays exactly what the file declares, the file is the source of any oddity; if
// Sard displays something DIFFERENT from what the file declares, that is a Sard defect.
//
// So every anomaly is classified as:
//   BOOK      Sard matches the file's own declaration — the file is like that
//   SARD      Sard differs from the file's own declaration
//   UNCERTAIN cannot be settled from the file alone; needs a second reader
//
// UNCERTAIN is a real verdict and is never upgraded to either side to make the report tidier.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIMIT = Number(process.argv.find((a) => a.startsWith("--limit="))?.slice(8) ?? 0);
const FROM = Number(process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? 0);
const SECTIONS = 6; // sections sampled per book — enough to catch order/blank/truncation cheaply

const snap = snapshotDb("M:\\eRawy", "library-audit");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const results = [];
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9900, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) {
    if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break;
    await sleep(400);
  }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  const total = await s.evaluate(`document.querySelectorAll('.lib-card').length`);
  const n = LIMIT ? Math.min(LIMIT, total) : total;
  console.log(`library: ${total} books · auditing ${n}\n`);

  // Books are addressed by TITLE, never by index. The grid re-orders itself once books have been
  // opened (a "continue reading" row appears), so index i is a different book on iteration i than it
  // was at launch — the first run reported 19 phantom "card not clickable" failures because of it.
  const keys = JSON.parse(await s.evaluate(`JSON.stringify([...document.querySelectorAll('.lib-card')]
    .map(c => (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,44)))`)).slice(0, n);

  for (let i = FROM; i < n; i++) {
    // Back to the library between books; a stale reader would make every later book measure the first.
    // Target the back control by its CLASS. Matching on the words "المكتبة"/"رجوع" matched TOC rows
    // whose chapter titles contain them (ch.38 «تغييرات لا رجوع فيها», ch.75 «المكتبة»), and .find()
    // took the first — so the audit clicked a chapter instead of going back, and every later book
    // reported "card not found". Text is content; class is identity.
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await sleep(400);

    const title = keys[i];
    const live = await s.evaluate(`document.querySelectorAll('.lib-card').length`);
    const find = `[...document.querySelectorAll('.lib-card')].find(c =>
      (c.textContent||'').replace(/\\s+/g,' ').trim().slice(0,44) === ${JSON.stringify(title)})`;
    // Bring it into view first: a card scrolled out of the pane can exist and still refuse the click.
    await s.evaluate(`(() => { const c = ${find}; if (c) c.scrollIntoView({block:'center'}); return !!c; })()`);
    await sleep(350);
    const clicked = await s.evaluate(`(() => { const c = ${find}; if (c) c.click(); return !!c; })()`);
    if (!clicked) {
      // Zero cards means we are not on the library at all. Capture WHAT the app is showing rather
      // than recording a bare failure — an empty grid, a stuck reader and a dead webview are three
      // different findings and only the DOM can tell them apart.
      const state = await s.evaluate(`(() => { const t = (document.body.textContent||'').replace(/\\s+/g,' ').trim();
        return JSON.stringify({ url: location.hash, cards: document.querySelectorAll('.lib-card').length,
          reader: !!document.querySelector('.page-host'), view: !!document.querySelector('foliate-view'),
          errorCard: !!document.querySelector('.error-card, [class*=error]'),
          bodyLen: t.length, head: t.slice(0, 160) }); })()`).catch((e) => `EVAL FAILED: ${e.message}`);
      results.push({ i, title, opened: false, error: `card not found (live cards: ${live})`, state });
      console.log(`  ${String(i).padStart(2)}. NOT FOUND  ${title.slice(0, 30)}  state=${typeof state === "string" ? state : JSON.stringify(state)}`);
      continue;
    }

    let opened = false;
    for (let k = 0; k < 90; k++) {
      if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.book`)) { opened = true; break; }
      await sleep(300);
    }
    if (!opened) {
      results.push({ i, title, opened: false, error: "never finished opening (90 x 300ms)" });
      console.log(`  ${String(i).padStart(2)}. FAILED TO OPEN  ${title}`);
      continue;
    }
    await sleep(2200);

    // ---- what the FILE declares, and what Sard SHOWS -----------------------------------------
    const m = JSON.parse(await s.evaluate(`(() => {
      const v = document.querySelector('.page-host foliate-view');
      const b = v?.book, r = v?.renderer;
      const spine = b?.sections?.length ?? null;                 // declared by the OPF spine
      const toc = b?.toc ?? null;                                // declared by nav doc or NCX
      const flat = (t, d = 0, out = []) => { for (const x of t ?? []) { out.push({ label: (x.label||'').trim().slice(0,40), href: x.href||'', d }); flat(x.subitems, d+1, out); } return out; };
      const tocFlat = flat(toc);
      // Does every TOC target actually resolve into the spine? A target that resolves nowhere is a
      // dead entry — and whether the book or Sard caused it is decided by comparing to the raw href.
      let resolvable = 0, unresolvable = [];
      for (const t of tocFlat) {
        let ok = false;
        try { ok = b.resolveHref && b.resolveHref(t.href) != null; } catch { ok = false; }
        if (ok) resolvable++; else unresolvable.push(t.label || t.href);
      }
      return JSON.stringify({
        spine, tocCount: tocFlat.length, tocDepth: Math.max(0, ...tocFlat.map(t=>t.d)),
        resolvable, unresolvable: unresolvable.slice(0,4),
        dir: b?.dir ?? null, flow: r?.getAttribute?.('flow') ?? null,
        firstLabels: tocFlat.slice(0,3).map(t=>t.label),
      });
    })()`));

    // What the READER sees: open the contents panel and count its rows. book.toc is the raw parse;
    // Sard synthesises from the spine when a book declares a useless one, and the panel is the truth.
    // Do NOT open the panel. RAWY-288 keeps it MOUNTED when closed (`inert` + `aria-hidden`), so its
    // rows are readable as they are. Toggling it was both unnecessary and destructive: the "is it
    // closed?" test matched the mounted rows, could never pass, and left the panel covering the back
    // control — which is what wedged the previous run at book 19.
    const panel = JSON.parse(await s.evaluate(`(() => {
      const rows = [...document.querySelectorAll('.toc-row, .toc-item, .reader-panel li, .reader-panel a')];
      const labels = rows.map((r) => (r.textContent || '').replace(/\\s+/g, ' ').trim()).filter(Boolean);
      return JSON.stringify({ rows: labels.length, first: labels.slice(0, 2) }); })()`));
    // Safety net only: if anything did leave a panel open, dismiss it by its real close control
    // (`.rp-x`) so the back button is reachable for the next book.
    await s.evaluate(`(() => { const x = document.querySelector('.rp-x'); if (x && x.offsetParent) x.click(); return true; })()`);
    await sleep(300);

    // ---- walk sections: order, emptiness, truncation, images ----------------------------------
    const walk = JSON.parse(await s.evaluate(`(async () => {
      const v = document.querySelector('.page-host foliate-view');
      const out = [];
      for (let k = 0; k < ${SECTIONS}; k++) {
        const c = v?.renderer?.getContents?.()?.[0];
        const d = c?.doc;
        if (!d) { out.push({ idx: null, err: 'no document' }); break; }
        const text = (d.body.textContent || '').replace(/\\s+/g, ' ').trim();
        const imgs = [...d.querySelectorAll('img')];
        let broken = 0;
        for (const im of imgs) { if (im.complete && im.naturalWidth === 0) broken++; }
        const cs = d.defaultView.getComputedStyle(d.body);
        out.push({
          idx: c.index, len: text.length, els: d.body.querySelectorAll('*').length,
          imgs: imgs.length, brokenImgs: broken,
          dir: cs.direction, colour: cs.color, bg: cs.backgroundColor,
          pages: v.renderer.pages ?? null, start: v.renderer.start ?? null, frac: v.lastLocation?.fraction ?? null,
        });
        try { await v.next(); } catch { break; }
        await new Promise(r => setTimeout(r, 900));
      }
      return JSON.stringify(out);
    })()`));

    const idxs = walk.map((w) => w.idx).filter((x) => x != null);
    const ordered = idxs.every((x, k) => k === 0 || x >= idxs[k - 1]);
    // Advanced = the reading POSITION moved, by section OR by page within a long section.
    const starts = walk.map(w=>w.start).filter(x=>x!=null);
    const advanced = (idxs.length>1 && idxs[idxs.length-1]>idxs[0]) || (starts.length>1 && starts[starts.length-1]!==starts[0]);
    const blanks = walk.filter((w) => w.len === 0).length;
    const brokenImgs = walk.reduce((a, w) => a + (w.brokenImgs || 0), 0);

    const r = { i, title, opened: true, ...m, panelRows: panel.rows, panelFirst: panel.first, sampled: walk.length, idxs, ordered, advanced, blanks, brokenImgs, walk };
    results.push(r);
    console.log(
      `  ${String(i).padStart(2)}. ${title.padEnd(46)} spine=${String(m.spine).padStart(4)} toc=${String(m.tocCount).padStart(4)}` +
      ` panel=${String(panel.rows).padStart(4)} resolv=${m.resolvable}/${m.tocCount} dir=${m.dir ?? "?"} order=${ordered?"ok":"BAD"}` +
      ` adv=${advanced ? "ok" : "NO"} blank=${blanks} brokenImg=${brokenImgs}`,
    );
  }
} catch (e) {
  console.error("\nAUDIT FAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync("M:/eRawy/tests/harness/library-audit-result.json", JSON.stringify(results, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`raw evidence: tests/harness/library-audit-result.json (${results.length} books)`);
}
