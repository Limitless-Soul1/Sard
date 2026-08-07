// SEARCH — measure every stage on a book that reportedly returns no results.
//
// Stages, in the order the pipeline runs them, each measured rather than assumed:
//   1. the section document exists and is reachable
//   2. it has a <body> (an XHTML parse failure leaves this null — the book's <html> has no xmlns)
//   3. the text is present in that body (ground truth taken from the FILE, not from the app)
//   4. the engine's own search generator runs and does not throw
//   5. the app's search surface returns rows
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";
import { readZip } from "./epub-nav.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (process.argv.find((a) => a.startsWith("--title=")) ?? "--title=omniscient").slice(8);

const db = new DatabaseSync(`${process.env.APPDATA}/com.sard.app/sard.db`, { readOnly: true });
const book = db.prepare("SELECT title, file_path FROM books WHERE title LIKE ?").get(`%${want}%`);
if (!book) { console.error(`no book matching ${want}`); process.exit(1); }

// GROUND TRUTH from the file: a phrase that certainly exists, and which section holds it.
const zip = readZip(book.file_path);
const docs = [...zip.entries.keys()].filter((n) => /\.x?html?$/i.test(n));
let needle = null, needleDoc = null;
for (const n of docs.slice(2, 12)) {
  const txt = zip.read(n).toString("utf8").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  const m = txt.slice(300, 340).trim();
  if (m.length > 12) { needle = m.split(" ").slice(1, 4).join(" "); needleDoc = n; break; }
}
console.log(`book      ${book.title}`);
console.log(`needle    ${JSON.stringify(needle)}   (from ${needleDoc?.split("/").pop()})`);
if (!needle) { console.error("could not extract a needle from the file"); process.exit(1); }

const snap = snapshotDb(REPO, "search-probe");
if (!snap) { console.error("FATAL: could not snapshot the profile."); process.exit(1); }

let out = 1;
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9363, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  await sleep(6000);
  await s.evaluate(
    `(() => { const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === ${JSON.stringify(book.title)});
       if (c) c.click(); return !!c; })()`,
  );
  await sleep(9000);

  // Stages 1-3, read from the live document.
  const doc = await s.evaluate(
    `(() => { const v = document.querySelector('foliate-view');
       const c = v?.renderer?.getContents?.()?.[0];
       const d = c?.doc;
       return { hasContents: !!c, hasDoc: !!d, hasBody: !!d?.body,
                contentType: d?.contentType ?? null,
                rootTag: d?.documentElement?.tagName ?? null,
                rootNS: d?.documentElement?.namespaceURI ?? null,
                bodyChars: (d?.body?.textContent ?? '').replace(/\\s+/g,' ').trim().length,
                docChars: (d?.documentElement?.textContent ?? '').replace(/\\s+/g,' ').trim().length,
                parserError: !!d?.querySelector?.('parsererror') }; })()`,
  );
  console.log(`\nSTAGE 1-3  ${JSON.stringify(doc)}`);

  // Stage 3b: THE PARSE SITE. Search does not use the rendered document — it builds its own via
  // `section.createDocument()`. Measure that directly, on several sections, so the null body is
  // observed at its origin rather than inferred from a stack trace.
  const parsed = await s.evaluate(
    `(async () => { const v = document.querySelector('foliate-view');
       const secs = v?.book?.sections ?? [];
       const out = [];
       for (const i of [0, 1, 5, 20]) {
         const sec = secs[i];
         if (!sec?.createDocument) { out.push({ i, error: 'no createDocument' }); continue; }
         try {
           const d = await sec.createDocument();
           out.push({ i, contentType: d?.contentType ?? null, rootNS: d?.documentElement?.namespaceURI ?? null,
                      hasBody: !!d?.body,
                      bodyTagPresent: !!d?.documentElement?.querySelector?.('body') || !!d?.getElementsByTagName?.('body')?.length,
                      chars: (d?.documentElement?.textContent ?? '').replace(/\\s+/g,' ').trim().length });
         } catch (e) { out.push({ i, threw: String(e).slice(0, 120) }); }
       }
       return out; })()`,
  );
  console.log(`STAGE 3b   createDocument(): ${JSON.stringify(parsed)}`);

  // Stage 3c: THE SAME SECTION, BOTH PATHS. The renderer parses as HTML; `createDocument` honours the
  // manifest's declared XHTML. Comparing them on ONE section answers whether HTML parsing recovers
  // the text that the XML parse loses — the question that decides whether a parse-site repair works.
  const both = await s.evaluate(
    `(async () => { const v = document.querySelector('foliate-view');
       await v.goTo(5); await new Promise(r => setTimeout(r, 2500));
       const c = v.renderer.getContents()[0];
       const rendered = (c?.doc?.body?.textContent ?? '').replace(/\\s+/g,' ').trim();
       const d = await v.book.sections[5].createDocument();
       const viaXml = (d?.documentElement?.textContent ?? '').replace(/\\s+/g,' ').trim();
       return { section: c?.index ?? null,
                renderedChars: rendered.length, renderedSample: rendered.slice(0, 50),
                createDocChars: viaXml.length, createDocHasBody: !!d?.body,
                renderedContentType: c?.doc?.contentType ?? null }; })()`,
  );
  console.log(`STAGE 3c   same section both paths: ${JSON.stringify(both)}`);

  // Stage 3d: PER-SECTION OR GLOBAL? After loading ONLY section 5, re-measure 1, 5 and 20.
  //   only 5 recovers      -> the change is per-section, caused by loading that section
  //   1 and 20 also recover-> something global changed (parser, loader state, a shared media type)
  //   nothing recovers     -> stage 3c measured something other than a fresh parse
  // Each is a different root cause, so this single comparison decides which mechanism is real.
  const after = await s.evaluate(
    `(async () => { const v = document.querySelector('foliate-view');
       const out = [];
       for (const i of [1, 5, 20]) {
         try {
           const d = await v.book.sections[i].createDocument();
           out.push({ i, contentType: d?.contentType ?? null, hasBody: !!d?.body,
                      chars: (d?.documentElement?.textContent ?? '').replace(/\\s+/g,' ').trim().length });
         } catch (e) { out.push({ i, threw: String(e).slice(0, 90) }); }
       }
       return out; })()`,
  );
  console.log(`STAGE 3d   after loading ONLY section 5: ${JSON.stringify(after)}`);

  // Stage 3e: FALSIFICATION. epub.js:819 logs 'Invalid XHTML' immediately before it rewrites
  // `item.mediaType` to HTML. If that warning does NOT fire while an untouched section is rendered,
  // the source-level explanation is wrong however well it fits, and the investigation reopens.
  // Prediction: the warning fires, and section 20 is HTML-parsed afterwards.
  const falsify = await s.evaluate(
    `(async () => { const v = document.querySelector('foliate-view');
       const seen = [];
       const orig = console.warn;
       console.warn = (...a) => { seen.push(a.map(String).join(' ').slice(0, 80)); orig(...a); };
       const before = await v.book.sections[20].createDocument();
       await v.goTo(20); await new Promise(r => setTimeout(r, 3000));
       const after = await v.book.sections[20].createDocument();
       console.warn = orig;
       return { warnings: seen.length, sample: seen.slice(0, 2),
                beforeType: before?.contentType ?? null, beforeBody: !!before?.body,
                afterType: after?.contentType ?? null, afterBody: !!after?.body }; })()`,
  );
  console.log(`STAGE 3e   falsification: ${JSON.stringify(falsify)}`);

  // Stage 6: CFI STABILITY — the one thing a reader cannot forgive us for corrupting.
  // Capture the CFI at a fixed location, then resolve it back. Run with and without the patch: if the
  // strings differ, saved positions/bookmarks/annotations shift under readers of affected books.
  const cfi = await s.evaluate(
    `(async () => { const v = document.querySelector('foliate-view');
       const wait = ms => new Promise(r => setTimeout(r, ms));
       // 1. go to a fixed location and read the engine's own CFI for it
       const grab = () => new Promise(res => {
         const h = e => { v.removeEventListener('relocate', h); res(e.detail?.cfi ?? null); };
         v.addEventListener('relocate', h);
         setTimeout(() => { v.removeEventListener('relocate', h); res(null); }, 5000);
       });
       const p = grab(); v.goTo(5); const captured = await p; await wait(1500);
       // 2. navigate away
       v.goTo(0); await wait(2500);
       const away = v.renderer.getContents()[0]?.index ?? null;
       // 3. resolve the SAME cfi back
       let landed = null, threw = null;
       if (captured) { try { await v.goTo(captured); await wait(2500);
                             landed = v.renderer.getContents()[0]?.index ?? null; }
                       catch (e) { threw = String(e).slice(0, 100); } }
       return { cfi: captured, away, landed, threw }; })()`,
  );
  console.log(`STAGE 6    CFI: ${JSON.stringify(cfi)}`);

  // Stage 7: THE LAST TWO CONSUMERS, measured rather than reasoned about.
  //   getTOCItemOf      — resolves a target to its TOC entry by applying an anchor to the document
  //   getSynthesisedToc — reads each section's first h1-h6 to label generated contents; measured here
  //                       by performing its exact core operation on the same input it consumes
  const consumers = await s.evaluate(
    `(async () => { const v = document.querySelector('foliate-view');
       let toc = null, tocThrew = null;
       try { const r = await v.getTOCItemOf(20); toc = r ? { label: String(r.label ?? '').slice(0, 40), href: String(r.href ?? '').slice(0, 40) } : null; }
       catch (e) { tocThrew = String(e).slice(0, 120); }
       const heads = [];
       for (const i of [1, 20, 40]) {
         const d = await v.book.sections[i].createDocument();
         const h = d?.body?.querySelector?.('h1,h2,h3,h4,h5,h6');
         heads.push({ i, hasBody: !!d?.body,
                      heading: h ? (h.textContent || '').replace(/\\s+/g,' ').trim().slice(0, 34) : null,
                      chars: (d?.body?.textContent ?? '').replace(/\\s+/g,' ').trim().length });
       }
       return { getTOCItemOf: toc, getTOCItemOfThrew: tocThrew, headingWalk: heads }; })()`,
  );
  console.log(`STAGE 7    consumers: ${JSON.stringify(consumers)}`);

  // Stage 4: the ENGINE's own search, called directly, so a throw is visible instead of swallowed.
  const engine = await s.evaluate(
    `(async () => { const v = document.querySelector('foliate-view');
       try {
         const it = v.search({ scope: 'book', query: ${JSON.stringify(needle)}, matchCase: false });
         let n = 0, first = null, subs = 0;
         for await (const r of it) { if (r?.subitems) { subs += r.subitems.length; } else if (r?.cfi) { n++; first ??= String(r.cfi).slice(0,60); } if (n + subs > 5) break; }
         return { threw: false, results: n, subitems: subs, first };
       } catch (e) { return { threw: true, error: String(e).slice(0, 200), stack: (e?.stack ?? '').split('\\n').slice(0,4).join(' | ') }; } })()`,
  );
  console.log(`STAGE 4    engine search: ${JSON.stringify(engine)}`);

  // Stage 5: the app's own search surface.
  const ui = await s.evaluate(
    `(() => { const b = [...document.querySelectorAll('.rc-btn')].find(x => /search|بحث/i.test(x.getAttribute('title')||''));
       if (!b) return 'no search button'; if (!b.classList.contains('on')) b.click(); return 'opened'; })()`,
  );
  await sleep(1500);
  await s.evaluate(
    `(() => { const i = document.querySelector('.rp-search input, .search-panel input, input[type=search]');
       if (!i) return false;
       const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
       setter.call(i, ${JSON.stringify(needle)});
       i.dispatchEvent(new Event('input', { bubbles: true }));
       i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
       return true; })()`,
  );
  await sleep(12000);
  const rows = await s.evaluate(
    `(() => ({ rows: document.querySelectorAll('.sr-row, .search-row, .rp-row').length,
               text: (document.querySelector('.search-panel, .rp-panel')?.textContent ?? '').replace(/\\s+/g,' ').trim().slice(0, 180) }))()`,
  );
  console.log(`STAGE 5    ui ${ui}: ${JSON.stringify(rows)}`);
  out = 0;
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  const ok = await restoreDb(snap);
  console.log(`profile restored: ${ok ? "OK" : "FAILED — CHECK MANUALLY"}`);
  if (!ok) out = 1;
}
process.exit(out);
