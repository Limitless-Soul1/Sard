// FALSIFICATION PASS on the claimed root cause of the one-entry contents list.
//
// CLAIM UNDER TEST (H1): the nav document is present but useless (1 junk link), and foliate's NCX
// fallback is keyed on PRESENCE (`if (!this.toc && ncxPath)`), so a complete 529-entry NCX is never
// consulted. Sard then recovers from the spine and shows ordinals.
//
// Reading the engine's source supports H1, but source reading cannot distinguish it from:
//
//   H2  the NCX in these books is not usable by the engine we ship (prefixes, malformed structure),
//       in which case reaching it would change nothing and the recommended fix would not work.
//   H3  Sard's own synthesis would OVERRIDE a good table of contents anyway, because the degeneracy
//       flag is computed from the nav document alone — in which case fixing the source selection in
//       the engine is not sufficient, and the fix must live in Sard.
//
// Two mutants of one real book discriminate all three, because each hypothesis predicts a different
// outcome. Only the input changes; the app, the engine and the book's content are held constant.
//
//   MUTANT A — remove `properties="nav"` from the OPF manifest.
//              The book then has NO nav document, which is the condition 13 healthy books in this
//              library already satisfy. H1 predicts real NCX chapter titles. H2 predicts failure.
//
//   MUTANT B — keep the nav document but EMPTY its toc.
//              foliate then falls back to the NCX (good titles), while Sard's Rust counter still
//              reads the nav document and sees 0 entries, so the book is still flagged degenerate.
//              H3 predicts the good titles appear and are then REPLACED by ordinals.
//
// Drives the REAL profile: snapshot before launch, restore on every exit path.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";
import { mutateEpub } from "./epub-mutate.mjs";
import { inspectEpub } from "./epub-nav.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const OUT = join(process.env.TEMP ?? ".", "sard-toc-falsify");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const db = new DatabaseSync(`${process.env.APPDATA}/com.sard.app/sard.db`, { readOnly: true });
const book = db.prepare("SELECT title, file_path FROM books WHERE title LIKE '%Kingdom%'").get();
if (!book) { console.error("Kingdom's Bloodline is not in the library"); process.exit(1); }
mkdirSync(OUT, { recursive: true });

// --- build the mutants ---------------------------------------------------------------------------
const isOpf = (n) => n.toLowerCase().endsWith(".opf");
const mutantA = join(OUT, "mutant-a-no-nav-property.epub");
const mutantB = join(OUT, "mutant-b-empty-nav-toc.epub");

// Each mutant also gets a UNIQUE TITLE. Without it every mutant imports under the book's own name,
// the library holds three identically-titled cards, and a click by title opens whichever came first —
// measured: the first run of this harness "tested" the original book twice and would have reported a
// surviving hypothesis that was never actually exercised.
const retitle = (s, tag) => s.replace(/(<dc:title[^>]*>)([\s\S]*?)(<\/dc:title>)/i, `$1${tag}$3`);

console.log(`source     ${book.file_path}`);
console.log(`A          ${mutateEpub(book.file_path, mutantA, (name, buf) => {
  if (!isOpf(name)) return buf;
  // Remove ONLY the nav property. Every other byte of the package document is untouched.
  return Buffer.from(retitle(buf.toString("utf8").replace(/\s+properties=("|')[^"']*\bnav\b[^"']*\1/gi, ""), "ZZ-MUTANT-A-no-nav"), "utf8");
}).join("; ")}`);

const navHrefOf = (p) => inspectEpub(p).navDoc.href;
const navHref = navHrefOf(book.file_path);
console.log(`B          ${mutateEpub(book.file_path, mutantB, (name, buf) => {
  if (isOpf(name)) return Buffer.from(retitle(buf.toString("utf8"), "ZZ-MUTANT-B-empty-nav"), "utf8");
  if (!navHref || !name.endsWith(navHref.split("/").pop())) return buf;
  // Keep the nav document and its <nav epub:type="toc">, but leave the list EMPTY.
  return Buffer.from(buf.toString("utf8").replace(/(<nav\b[^>]*epub:type=("|')[^"']*toc[^"']*\2[^>]*>)[\s\S]*?(<\/nav>)/i, "$1<ol></ol>$3"), "utf8");
}).join("; ")}`);

// Confirm the mutation did what it claims BEFORE drawing any conclusion from the app's behaviour.
for (const [label, p] of [["original", book.file_path], ["mutant A", mutantA], ["mutant B", mutantB]]) {
  const r = inspectEpub(p);
  console.log(`  ${label.padEnd(9)} navDoc ${String(r.navDoc.present).padEnd(5)} navTocLinks ${String(r.navDoc.tocLinks ?? "-").padEnd(4)} ncx ${r.ncx.navPoints}  spine ${r.spine.linear}`);
}

// --- run each mutant through the real app ---------------------------------------------------------
const snap = snapshotDb(REPO, "toc-falsify");
if (!snap) { console.error("FATAL: could not snapshot the profile. NOTHING was verified."); process.exit(1); }

let out = 1;
let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9355, timeoutMs: 60_000 });
  if (s.skipped) throw new Error(s.skipped);
  await sleep(6000);

  for (const [label, path] of [["MUTANT A (no nav document)", mutantA], ["MUTANT B (nav present, toc empty)", mutantB]]) {
    if (!existsSync(path)) { console.log(`\n${label}: NOT BUILT`); continue; }
    const res = await s.evaluate(
      `window.__TAURI_INTERNALS__.invoke('import_books', { paths: [${JSON.stringify(path)}] }).catch(e => ({ __err: String(e) }))`,
    );
    const id = res?.imported?.[0]?.id ?? res?.books?.[0]?.id ?? res?.[0]?.id;
    if (!id) { console.log(`\n${label}: import failed — ${JSON.stringify(res).slice(0, 160)}`); continue; }
    const row = await s.evaluate(
      `window.__TAURI_INTERNALS__.invoke('library_list_books', { sort: 'added', order: 'desc' }).then(b => b.find(x => x.id === ${JSON.stringify(id)}) ?? null)`,
    );
    console.log(`\n${label}`);
    console.log(`  imported as   "${row?.title}"   toc_degenerate=${row?.toc_degenerate}`);

    await s.evaluate(`(() => { location.reload(); return true; })()`).catch(() => {});
    await sleep(9000);
    await s.evaluate(
      `(() => { const c = [...document.querySelectorAll('.lib-card')].find(x => (x.getAttribute('title')||'') === ${JSON.stringify(row?.title ?? "")});
         if (c) c.click(); return !!c; })()`,
    );
    // Watch the contents list evolve: the ORDER of what appears is the discriminator.
    const seen = [];
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const snapRows = await s.evaluate(
        `(() => { const r = [...document.querySelectorAll('.toc-row')];
           return { n: r.length, synth: !!document.querySelector('.rp-synth-note'),
                    first: r.slice(0, 3).map(x => (x.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 30)) }; })()`,
      );
      if (i === 2) await s.evaluate(
        `(() => { const b = [...document.querySelectorAll('.rc-btn')].find(y => /contents|فهرس|المحتويات/i.test(y.getAttribute('title')||''));
           if (b && !b.classList.contains('on')) b.click(); return true; })()`,
      );
      const key = `${snapRows.n}|${snapRows.synth}|${snapRows.first[0] ?? ""}`;
      if (!seen.length || seen[seen.length - 1].key !== key) {
        seen.push({ key, ...snapRows, at: (i + 1) * 1000 });
        console.log(`  [${String((i + 1) * 1000).padStart(6)} ms] rows=${String(snapRows.n).padStart(4)}  synthesised=${snapRows.synth}  first=${JSON.stringify(snapRows.first)}`);
      }
    }
    await s.evaluate(`(() => { const b = document.querySelector('.rc-back'); if (b) b.click(); return true; })()`).catch(() => {});
    await sleep(2500);
  }
  out = 0;
} catch (e) {
  console.error(`\nFAILED: ${e.message}`);
} finally {
  try { execFileSync("taskkill", ["/F", "/IM", "Sard.exe", "/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  const ok = await restoreDb(snap);
  console.log(`\nprofile restored: ${ok ? "OK" : "FAILED — CHECK MANUALLY"}`);
  if (!ok) out = 1;
}
process.exit(out);
