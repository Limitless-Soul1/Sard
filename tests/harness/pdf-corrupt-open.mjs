// Four damaged PDFs are ACCEPTED by the importer (header-sniffed, not parsed). The question that
// actually matters to a reader is what happens when one is opened: a clear message is fine, a hang or
// a silent blank reader is not. The previous run could not answer it — the library grid had not
// refreshed inside the run — so here the webview is reloaded after importing.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIB = process.env.APPDATA + "\\com.sard.app\\library";
const FIX = "M:\\eRawy\\tests\\harness\\.corrupt-pdf";
const DONOR = readFileSync(LIB + "\\" + readdirSync(LIB).find((f) => f.endsWith(".pdf")));

if (existsSync(FIX)) rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
const FIXTURES = [
  ["ZZtruncated.pdf", DONOR.subarray(0, Math.floor(DONOR.length * 0.4))],
  ["ZZnotrailer.pdf", DONOR.subarray(0, DONOR.length - 600)],
  ["ZZgarbage.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(Array.from({ length: 40000 }, () => Math.floor(Math.random() * 256)))])],
  ["ZZheaderonly.pdf", Buffer.from("%PDF-1.7\n")],
];
for (const [n, b] of FIXTURES) writeFileSync(`${FIX}\\${n}`, b);

const before = new Set(readdirSync(LIB));
const snap = snapshotDb("M:\\eRawy", "pdf-corrupt-open");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const out = [];
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9914, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  const paths = FIXTURES.map(([n]) => `${FIX}\\${n}`);
  console.log(await s.evaluate(`(async () => { const r = await window.__TAURI_INTERNALS__.invoke('import_books', { paths: ${JSON.stringify(paths)} });
    return JSON.stringify(r.map(x => x.title + ':' + x.status)); })()`));

  await s.evaluate(`location.reload()`).catch(() => {});
  await sleep(6000);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`).catch(() => false)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`).catch(() => false)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err = [];
    window.addEventListener('error', e => window.__err.push((e.message||'').slice(0,140)));
    window.addEventListener('unhandledrejection', e => window.__err.push('reject: ' + String(e.reason).slice(0,140)));
    return true; })()`);
  console.log(`cards after reload: ${await s.evaluate(`document.querySelectorAll('.lib-card').length`)}\n`);

  for (const [name] of FIXTURES) {
    const stem = name.replace(/\.pdf$/, "");
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
    await s.evaluate(`(() => { window.__err = []; return true; })()`);
    const found = await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(stem)})); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!found) { console.log(`  ${stem}: CARD NOT PRESENT`); out.push({ stem, card: false }); continue; }

    const t = Date.now();
    let st = null, settledAt = null;
    for (let k = 0; k < 70; k++) {   // 21 s ceiling — a broken file must resolve, not spin
      st = JSON.parse(await s.evaluate(`(() => {
        const err = document.querySelector('.error-card, .book-error, [class*=error]');
        const v = document.querySelector('.page-host foliate-view');
        const d = v?.renderer?.getContents?.()?.[0]?.doc;
        const im = d?.querySelector('img, canvas');
        return JSON.stringify({ errorShown: !!err, errorText: (err?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,140),
          painted: !!im, inReader: !!document.querySelector('.page-host'),
          backInLibrary: document.querySelectorAll('.lib-card').length > 0,
          toast: (document.querySelector('.pdf-toast')?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,140),
          bodyHead: (document.body.textContent||'').replace(/\\s+/g,' ').trim().slice(0,90) }); })()`));
      if (st.errorShown || st.painted || st.backInLibrary || st.toast) { settledAt = Date.now() - t; break; }
      await sleep(300);
    }
    const errs = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 4))`));
    const verdict = st.errorShown || st.toast ? "EXPLAINED" : st.backInLibrary ? "bounced back to library"
      : st.painted ? "rendered something" : "NO RESOLUTION (spun until timeout)";
    out.push({ stem, ms: settledAt ?? Date.now() - t, verdict, ...st, errs });
    console.log(`  ${stem.padEnd(14)} ${String(settledAt ?? ">21000").padStart(6)} ms  ${verdict}`);
    console.log(`      ${JSON.stringify({ err: st.errorText, toast: st.toast, painted: st.painted, inReader: st.inReader, body: st.bodyHead })}`);
    if (errs.length) console.log(`      page errors: ${JSON.stringify(errs)}`);
  }
} catch (e) {
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  let removed = 0;
  for (const f of readdirSync(LIB)) if (!before.has(f)) { try { rmSync(`${LIB}\\${f}`, { force: true, recursive: true }); removed++; } catch { /* locked */ } }
  rmSync(FIX, { recursive: true, force: true });
  writeFileSync("M:/eRawy/tests/harness/pdf-corrupt-open-result.json", JSON.stringify(out, null, 1));
  console.log(`\nlibrary files added and removed: ${removed}`);
  console.log(`profile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
