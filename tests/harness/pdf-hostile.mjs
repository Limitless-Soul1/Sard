// HOSTILE PDF FIXTURES + BLANK-PAGE DISCRIMINATION.
//
// Part 1 — malformed files. Import six deliberately broken PDFs. The bar is NOT "it opens": these
// files are unopenable by anything. The bar is that Sard REFUSES them cleanly — a clear message, no
// hang, no crash, no blank reader with no explanation. A reader who taps a corrupt file must be told.
//
// Part 2 — blank pages. The stress run saw pages with no ink. A page can be blank because the file's
// page IS blank, or because rendering had not finished. Those are told apart by re-sampling the SAME
// page after a further delay: still blank => the page is blank; now inked => the first read was early.
//
// CLEANUP does not depend on the run going well: the library directory is listed before and any file
// that appears is removed afterwards, and the profile is snapshot/restored regardless.
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LIB = process.env.APPDATA + "\\com.sard.app\\library";
const FIX = "M:\\eRawy\\tests\\harness\\.hostile-pdf";

// A real PDF to derive the damaged ones from, so "truncated" means truncated, not "random bytes".
const DONOR = readFileSync(process.env.APPDATA + "\\com.sard.app\\library\\"
  + readdirSync(process.env.APPDATA + "\\com.sard.app\\library").find((f) => f.endsWith(".pdf")));

if (existsSync(FIX)) rmSync(FIX, { recursive: true, force: true });
mkdirSync(FIX, { recursive: true });
const FIXTURES = [
  ["truncated.pdf", DONOR.subarray(0, Math.floor(DONOR.length * 0.4)), "valid header, cut off mid-body — xref points past EOF"],
  ["no-trailer.pdf", DONOR.subarray(0, DONOR.length - 600), "body intact, trailer and startxref removed"],
  ["garbage.pdf", Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.from(Array.from({ length: 40000 }, () => Math.floor(Math.random() * 256)))]), "PDF header, random bytes after it"],
  ["not-a-pdf.pdf", Buffer.from("This is a plain text file that has been given a .pdf extension.\n".repeat(40)), "text file wearing a .pdf extension"],
  ["empty.pdf", Buffer.alloc(0), "zero bytes"],
  ["header-only.pdf", Buffer.from("%PDF-1.7\n"), "header and nothing else"],
];
for (const [name, buf] of FIXTURES) writeFileSync(`${FIX}\\${name}`, buf);
console.log(`fixtures written to ${FIX}\n`);

const before = new Set(readdirSync(LIB));
const snap = snapshotDb("M:\\eRawy", "pdf-hostile");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
const out = { malformed: [], blanks: null };
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9912, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 60; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  await s.evaluate(`(() => { window.__err = [];
    window.addEventListener('error', e => window.__err.push('error: ' + (e.message||'').slice(0,140)));
    window.addEventListener('unhandledrejection', e => window.__err.push('reject: ' + String(e.reason).slice(0,140)));
    return true; })()`);

  // ---- PART 1: does the importer refuse damaged files, and say so? --------------------------
  console.log("=== malformed files ===");
  for (const [name, , why] of FIXTURES) {
    const t = Date.now();
    let res;
    try {
      res = await s.evaluate(`(async () => { try {
        const r = await window.__TAURI_INTERNALS__.invoke('import_books', { paths: [${JSON.stringify(`${FIX}\\${name}`)}] });
        return JSON.stringify({ ok: true, r });
      } catch (e) { return JSON.stringify({ ok: false, err: String(e).slice(0, 200) }); } })()`);
    } catch (e) { res = JSON.stringify({ ok: false, err: "evaluate failed: " + e.message }); }
    const ms = Date.now() - t;
    let parsed; try { parsed = JSON.parse(res); } catch { parsed = { raw: String(res).slice(0, 200) }; }
    const alive = await s.evaluate(`!!document.querySelector('.lib-grid, .lib-card, .library-root, body')`).catch(() => false);
    const rec = { name, why, ms, result: parsed, appAlive: !!alive };
    out.malformed.push(rec);
    console.log(`  ${name.padEnd(16)} ${String(ms).padStart(5)} ms  alive=${rec.appAlive}  ${JSON.stringify(parsed).slice(0, 170)}`);
  }
  out.errorsAfterImports = JSON.parse(await s.evaluate(`JSON.stringify(window.__err.slice(0, 10))`));
  console.log(`  page errors during imports: ${JSON.stringify(out.errorsAfterImports)}`);

  // Whatever DID import: can the reader open it without hanging, and does it explain itself?
  const cards = await s.evaluate(`document.querySelectorAll('.lib-card').length`);
  console.log(`  library cards now: ${cards}`);
  for (const [name] of FIXTURES) {
    const stem = name.replace(/\.pdf$/, "");
    const found = await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')]
      .find(c => (c.textContent||'').includes(${JSON.stringify(stem)})); if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
    if (!found) continue;
    const t = Date.now();
    let settled = null;
    for (let k = 0; k < 60; k++) {   // 18s: a broken file must resolve one way or the other quickly
      settled = JSON.parse(await s.evaluate(`(() => {
        const err = document.querySelector('.error-card, .book-error, [class*=error]');
        const v = document.querySelector('.page-host foliate-view');
        const d = v?.renderer?.getContents?.()?.[0]?.doc;
        return JSON.stringify({ errorShown: !!err, errorText: (err?.textContent||'').replace(/\\s+/g,' ').trim().slice(0,120),
          painted: !!d?.querySelector('img, canvas'), inReader: !!document.querySelector('.page-host'),
          inLibrary: document.querySelectorAll('.lib-card').length > 0 }); })()`));
      if (settled.errorShown || settled.painted || settled.inLibrary) break;
      await sleep(300);
    }
    console.log(`  OPEN ${stem.padEnd(14)} ${String(Date.now() - t).padStart(5)} ms  ${JSON.stringify(settled)}`);
    out.malformed.find((m) => m.name.startsWith(stem)).open = { ms: Date.now() - t, ...settled };
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
    await sleep(1200);
  }

  // ---- PART 2: is a blank page blank, or merely early? --------------------------------------
  console.log("\n=== blank pages (رسالة الغفران — 6 of 20 sampled pages had no ink) ===");
  await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return !!b; })()`);
  for (let k = 0; k < 40; k++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(250); }
  await s.evaluate(`(() => { const c = [...document.querySelectorAll('.lib-card')].find(c => (c.textContent||'').includes('33102'));
    if (c) { c.scrollIntoView({block:'center'}); c.click(); } return !!c; })()`);
  await sleep(6000);
  const INK = `(() => { const v = document.querySelector('.page-host foliate-view');
    const d = v?.renderer?.getContents?.()?.[0]?.doc; const im = d?.querySelector('img');
    if (!im || !im.complete || !im.naturalWidth) return JSON.stringify({ ready: false });
    try { const c = d.createElement('canvas'); c.width = Math.min(im.naturalWidth, 400); c.height = Math.min(im.naturalHeight, 400);
      const g = c.getContext('2d'); g.drawImage(im, 0, 0, c.width, c.height);
      const px = g.getImageData(0, 0, c.width, c.height).data; let ink = 0, n = 0;
      for (let i = 0; i < px.length; i += 4 * 13) { n++; if (px[i] < 235 || px[i+1] < 235 || px[i+2] < 235) ink++; }
      return JSON.stringify({ ready: true, ink: +(ink / Math.max(1, n)).toFixed(4), frac: v.lastLocation?.fraction ?? null });
    } catch (e) { return JSON.stringify({ ready: false, err: String(e).slice(0, 60) }); } })()`;
  const series = [];
  for (let k = 0; k < 26; k++) {
    let a = JSON.parse(await s.evaluate(INK));
    for (let w = 0; w < 40 && !a.ready; w++) { await sleep(150); a = JSON.parse(await s.evaluate(INK)); }
    let recheck = null;
    if (a.ready && a.ink < 0.001) { await sleep(2500); recheck = JSON.parse(await s.evaluate(INK)); }  // the discriminator
    series.push({ page: k + 1, ink: a.ink ?? null, afterWait: recheck ? recheck.ink : null });
    await s.evaluate(`(() => { document.querySelector('.page-host foliate-view')?.next(); return true; })()`);
    await sleep(700);
  }
  const blank = series.filter((x) => x.ink !== null && x.ink < 0.001);
  const stayedBlank = blank.filter((x) => x.afterWait !== null && x.afterWait < 0.001);
  out.blanks = { sampled: series.length, blank: blank.length, stayedBlankAfterWait: stayedBlank.length, series };
  console.log(`  ${series.length} consecutive pages · ${blank.length} with no ink · ${stayedBlank.length} still blank after a further 2.5 s`);
  console.log(`  ink series: ${series.map((x) => (x.ink === null ? "?" : x.ink < 0.001 ? "·" : "#")).join("")}`);
  console.log(`  (# = inked, · = blank, ? = never became ready)`);
} catch (e) {
  console.error("\nHOSTILE RUN FAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  // Remove anything the imports added — verified by name against the pre-run listing, no app needed.
  let removed = 0;
  for (const f of readdirSync(LIB)) if (!before.has(f)) { try { rmSync(`${LIB}\\${f}`, { force: true, recursive: true }); removed++; } catch { /* locked */ } }
  rmSync(FIX, { recursive: true, force: true });
  writeFileSync("M:/eRawy/tests/harness/pdf-hostile-result.json", JSON.stringify(out, null, 1));
  console.log(`\nlibrary files added by this run and removed: ${removed}`);
  console.log(`profile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
}
