// Which elements are genuinely NON-RENDERED inside Sard's sandboxed content iframe?
//
// READ-ONLY: injects a probe block into a loaded chapter document, measures, then removes it. No
// product code is changed and the page is restored.
//
// WHY THIS IS NOT OBVIOUS. The proposed exclusion set is script / style / noscript / template. Three of
// those are unconditional, but <noscript> is NOT: the HTML parser only treats its contents as raw text
// when the SCRIPTING FLAG IS ENABLED. Sard's content iframes are sandboxed `allow-same-origin` with no
// `allow-scripts` (the RAWY-64 patch), so scripting is DISABLED there — and with scripting disabled a
// browser PARSES AND RENDERS <noscript> content as ordinary markup. If that is what happens here, then
// excluding <noscript> would delete text the reader can actually see, which is exactly the failure the
// fix must not introduce.
//
// <template> is also worth measuring rather than assuming: its children are parsed into a separate
// DocumentFragment (`.content`) and are NOT part of the document tree, so a TreeWalker should never
// reach them at all — making its exclusion a documented no-op rather than a real guard.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OUT = "M:/eRawy/tests/harness/tts-nonrendered-probe-result.json";

const report = { startedAt: new Date().toISOString(), verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "nonrendered-probe");
if (!snap) { console.error("FATAL: could not snapshot the profile"); process.exit(1); }

let s;
try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9956, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,160)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format).toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  await s.evaluate(`(() => { const t=${JSON.stringify(epub.title ?? "")};
    const all=[...document.querySelectorAll('.lib-card')];
    const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
    if (c) c.click(); return !!c; })()`);
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
  await sleep(2500);
  console.log(`host book: "${epub.title}"\n`);

  const res = JSON.parse(await s.evaluate(`(() => {
    const v = document.querySelector('.page-host foliate-view');
    const d = v?.renderer?.getContents?.()?.[0]?.doc;
    if (!d?.body) return JSON.stringify({ err: 'no doc' });
    const win = d.defaultView;
    // Is scripting actually disabled in this frame? (the sandbox question, answered directly)
    let scriptingRuns = false;
    try { const probe = d.createElement('script'); probe.textContent = 'window.__scriptRan = true;';
      d.body.appendChild(probe); scriptingRuns = win.__scriptRan === true; probe.remove(); } catch (e) {}

    const host = d.createElement('div');
    host.id = '__nr_probe';
    host.innerHTML =
      '<div class="c1"><script>SCRIPTPAYLOAD</' + 'script></div>' +
      '<div class="c2"><style>.x{color:red}</style></div>' +
      '<div class="c3"><noscript>NOSCRIPTPAYLOAD</noscript></div>' +
      '<div class="c4"><template>TEMPLATEPAYLOAD</template></div>' +
      '<div class="c5">VISIBLE<span style="display:none">HIDDENSPAN</span></div>';
    d.body.appendChild(host);

    const CONTAINER = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, div, section, article';
    const probe = (cls) => {
      const c = host.querySelector('.' + cls);
      const inner = c.firstElementChild;
      // exactly what segmentBlock does: SHOW_TEXT TreeWalker with NO filter
      const w = d.createTreeWalker(c, NodeFilter.SHOW_TEXT);
      const collected = [];
      for (let n = w.nextNode(); n; n = w.nextNode()) if (n.data.length) collected.push(n.data.trim());
      const cs = inner ? win.getComputedStyle(inner) : null;
      const ccs = win.getComputedStyle(c);
      return {
        innerTag: inner ? inner.tagName.toLowerCase() : null,
        innerDisplay: cs ? cs.display : null,
        containerDisplay: ccs.display,
        containerVisibility: ccs.visibility,
        containerIsLeaf: !c.querySelector(CONTAINER),
        containerTextContent: (c.textContent || '').trim().slice(0, 40),
        walkerCollected: collected.filter(Boolean),
        innerTextSeenByReader: (c.innerText || '').trim().slice(0, 40),
        offsetHeight: c.offsetHeight,
      };
    };
    const out = { scriptingRuns, script: probe('c1'), style: probe('c2'),
      noscript: probe('c3'), template: probe('c4'), hiddenSpan: probe('c5') };
    host.remove();
    out.removed = !d.getElementById('__nr_probe');
    return JSON.stringify(out);
  })()`));

  report.probe = res;
  console.log(`scripting enabled inside the content iframe: ${res.scriptingRuns}  (expected false — RAWY-64 sandbox)\n`);
  const row = (name, r) => {
    console.log(`${name.padEnd(11)} inner=<${r.innerTag}> display=${String(r.innerDisplay).padEnd(7)}`
      + ` | textContent="${r.containerTextContent}"`);
    console.log(`${''.padEnd(11)} TreeWalker collected: ${JSON.stringify(r.walkerCollected)}`);
    console.log(`${''.padEnd(11)} reader sees (innerText): "${r.innerTextSeenByReader}"  height=${r.offsetHeight}`);
    console.log("");
  };
  row("script", res.script);
  row("style", res.style);
  row("noscript", res.noscript);
  row("template", res.template);
  row("hidden span", res.hiddenSpan);

  const leaks = (r, payload) => r.walkerCollected.some((t) => t.includes(payload));
  const visible = (r, payload) => r.innerTextSeenByReader.includes(payload);
  report.verdicts = {
    scriptLeaks: leaks(res.script, "SCRIPTPAYLOAD"), scriptVisible: visible(res.script, "SCRIPTPAYLOAD"),
    styleLeaks: leaks(res.style, "color:red"), styleVisible: visible(res.style, "color:red"),
    noscriptLeaks: leaks(res.noscript, "NOSCRIPTPAYLOAD"), noscriptVisible: visible(res.noscript, "NOSCRIPTPAYLOAD"),
    templateReachedByWalker: leaks(res.template, "TEMPLATEPAYLOAD"), templateVisible: visible(res.template, "TEMPLATEPAYLOAD"),
    hiddenSpanLeaks: leaks(res.hiddenSpan, "HIDDENSPAN"), hiddenSpanVisible: visible(res.hiddenSpan, "HIDDENSPAN"),
    probeRemoved: res.removed,
  };
  const V = report.verdicts;
  console.log("--- exclusion safety ---");
  const verdict = (n, l, vis) => console.log(
    `  ${n.padEnd(12)} reaches TTS=${String(l).padEnd(5)} visible to reader=${String(vis).padEnd(5)} -> `
    + (l && !vis ? "SAFE TO EXCLUDE (leaks, invisible)" : l && vis ? "⚠ DO NOT EXCLUDE (visible prose)" : "no leak"));
  verdict("script", V.scriptLeaks, V.scriptVisible);
  verdict("style", V.styleLeaks, V.styleVisible);
  verdict("noscript", V.noscriptLeaks, V.noscriptVisible);
  verdict("template", V.templateReachedByWalker, V.templateVisible);
  verdict("display:none", V.hiddenSpanLeaks, V.hiddenSpanVisible);
  console.log(`\n  probe removed cleanly: ${V.probeRemoved}`);
} catch (e) {
  report.fatal = e.message;
  console.error("\nFAILED:", e.message);
} finally {
  try { if (s) await s.close(); } catch { /* gone */ }
  try { execFileSync("taskkill", ["/F","/IM","Sard.exe","/T"], { stdio: "ignore" }); } catch { /* gone */ }
  await sleep(1500);
  writeFileSync(OUT, JSON.stringify(report, null, 1));
  console.log(`\nprofile restored: ${(await restoreDb(snap)) ? "OK" : "FAILED — CHECK MANUALLY"}`);
  console.log(`result: ${OUT}`);
}
