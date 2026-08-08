// INVESTIGATION TOOLING — does a MOVING background damage text contrast? Not production code.
//
// The previous study measured performance and named this as its most important gap. It is answerable
// exactly, because the compositing is fixed and its constants are shipped:
//
//     paper_seen  =  pageSheet(paperBg, α = pageOpacity)   over
//                    scrim(regrounded paper colour, α = scrimAlpha)   over
//                    media pixel
//
// so the media's share of the colour behind text is  (1 − pageOpacity) × (1 − scrimAlpha).
// With the shipped floors (PAGE_OPACITY_MIN 0.84, READ_SCRIM_MIN 0.62) that is 0.16 × 0.38 = 6.08 %.
//
// What is NOT known analytically is how far a real clip's luminance actually travels, so THAT is what
// this measures: per-frame luminance of each characterised clip, sampled from the decoded frames in
// the real engine. The contrast maths is then exact rather than assumed, and the theme colours are
// read from the running app rather than transcribed.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Where the sample clips live. They are tens of MB of video, deliberately not committed, so the
// location is a PARAMETER and never a constant:  --media=<dir>  |  $SARD_MEDIA_DIR  |  ./.media
// A machine-specific absolute path was hard-coded here once, which made the harness unrunnable
// anywhere but the one machine that wrote it — and put that machine's directory layout in the repo.
const MEDIA =
  process.argv.find((a) => a.startsWith("--media="))?.slice(8) ??
  process.env.SARD_MEDIA_DIR ??
  join(import.meta.dirname, ".media");
const OUT = "M:/eRawy/tests/harness/bg-media-readability-result.json";

const CLIPS = [
  { f: "c_bright.mp4", label: "bright / near-white" },
  { f: "c_dark.mp4", label: "dark / near-black" },
  { f: "c_edges.mp4", label: "hard edges (test pattern)" },
  { f: "c_rapid.mp4", label: "rapid motion" },
  { f: "c_slow.mp4", label: "slow gradient" },
  { f: "c_colour.mp4", label: "saturated colour" },
];

const report = { startedAt: new Date().toISOString(), clips: [], themes: [], lifecycle: [], verdicts: {} };
const snap = snapshotDb("M:\\eRawy", "bg-readability");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
async function pushMedia(file, mime) {
  const b64 = readFileSync(join(MEDIA, file)).toString("base64");
  await s.evaluate(`window.__chunks = [];`);
  const CH = 700_000;
  for (let i = 0; i < b64.length; i += CH) await s.evaluate(`window.__chunks.push(${JSON.stringify(b64.slice(i, i + CH))});`);
  return s.evaluate(`(() => { const b64 = window.__chunks.join(''); window.__chunks = null;
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    if (window.__mUrl) URL.revokeObjectURL(window.__mUrl);
    window.__mUrl = URL.createObjectURL(new Blob([u8], { type: ${JSON.stringify(mime)} })); return true; })()`);
}

/** Decode frames into a canvas and report luminance statistics over a real playback window. */
const SAMPLE_LUMA = (ms) => `(async () => {
  const v = document.createElement('video');
  v.src = window.__mUrl; v.muted = true; v.loop = true; v.playsInline = true;
  document.body.appendChild(v);
  await new Promise(r => { v.onloadeddata = r; setTimeout(r, 6000); });
  try { await v.play(); } catch (e) {}
  // Wait for a PAINTED frame. The first version sampled immediately and captured an unpainted canvas,
  // which put a luminance-0 outlier in every clip and made the swing figure equal to the maximum.
  // Those runs were void. Gate on readyState AND on currentTime advancing, then discard a warm-up.
  for (let i = 0; i < 200 && !(v.readyState >= 2 && v.currentTime > 0); i++) await new Promise(r => setTimeout(r, 25));
  for (let i = 0; i < 8; i++) await new Promise(r => requestAnimationFrame(r));
  const W = 160, H = 90;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const frames = [];
  const t0 = performance.now();
  while (performance.now() - t0 < ${ms}) {
    ctx.drawImage(v, 0, 0, W, H);
    const d = ctx.getImageData(0, 0, W, H).data;
    let sum = 0, mn = 255, mx = 0;
    for (let i = 0; i < d.length; i += 4) {
      // Rec.709 relative luminance on sRGB bytes (perceptual weighting, pre-linearisation)
      const y = 0.2126 * d[i] + 0.7152 * d[i+1] + 0.0722 * d[i+2];
      sum += y; if (y < mn) mn = y; if (y > mx) mx = y;
    }
    frames.push({ mean: sum / (d.length / 4), min: mn, max: mx });
    await new Promise(r => requestAnimationFrame(r));
  }
  v.pause(); v.remove();
  const means = frames.map(f => f.mean);
  let maxDelta = 0;
  for (let i = 1; i < means.length; i++) maxDelta = Math.max(maxDelta, Math.abs(means[i] - means[i-1]));
  const sorted = [...means].sort((a,b) => a-b);
  const q = (p) => sorted[Math.min(sorted.length-1, Math.floor(sorted.length*p))];
  // Report p02/p98 as well as the absolute extremes: a single decode hiccup must not be allowed to
  // define "the swing", which is exactly how the first run went wrong.
  return JSON.stringify({ frames: frames.length,
    meanLuma: +(means.reduce((a,b)=>a+b,0)/means.length).toFixed(1),
    minFrameMean: +sorted[0].toFixed(1), maxFrameMean: +sorted[sorted.length-1].toFixed(1),
    p02: +q(0.02).toFixed(1), p98: +q(0.98).toFixed(1),
    swingP02P98: +(q(0.98) - q(0.02)).toFixed(1),
    frameMeanSwing: +(sorted[sorted.length-1] - sorted[0]).toFixed(1),
    darkestPixel: +Math.min(...frames.map(f=>f.min)).toFixed(1),
    brightestPixel: +Math.max(...frames.map(f=>f.max)).toFixed(1),
    maxFrameToFrameDelta: +maxDelta.toFixed(2) });
})()`;

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9962, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  await s.send("Performance.enable");
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }
  const inv = (c, p = {}) => s.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(c)}, ${JSON.stringify(p)}).then(r=>({ok:r})).catch(e=>({__err:String(e).slice(0,120)}))`);
  const books = (await inv("library_list_books", { sort: "added", order: "desc", format: null, collection: null, search: null }))?.ok;
  const epub = (Array.isArray(books) ? books : []).filter((b) => String(b.format).toLowerCase() === "epub")
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
  await s.evaluate(`(() => { const t=${JSON.stringify(epub.title ?? "")};
    const all=[...document.querySelectorAll('.lib-card')];
    const c = all.find(x => (x.getAttribute('title')||'') === t) || all.find(x => (x.getAttribute('title')||'').includes(t));
    if (c) c.click(); return !!c; })()`);
  for (let k = 0; k < 150; k++) { if (await s.evaluate(`!!document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc?.body`)) break; await sleep(300); }
  await sleep(2500);

  // ---- the shipped constants and the live theme colours, read from the app --------------------
  report.constants = JSON.parse(await s.evaluate(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const deskCs = getComputedStyle(document.querySelector('.reader-desk'));
    const doc = document.querySelector('.page-host foliate-view')?.renderer?.getContents?.()?.[0]?.doc;
    const body = doc?.body ? doc.defaultView.getComputedStyle(doc.body) : null;
    return JSON.stringify({
      scrimBase: cs.getPropertyValue('--bg-rd-scrim-base').trim() || null,
      rdBlur: cs.getPropertyValue('--bg-rd-blur').trim() || null,
      readerBg: cs.getPropertyValue('--reader-bg').trim() || null,
      text: cs.getPropertyValue('--text').trim() || null,
      deskBg: deskCs.backgroundColor,
      pageText: body ? body.color : null, pageBg: body ? body.backgroundColor : null,
      theme: document.documentElement.getAttribute('data-theme'),
    }); })()`));
  console.log("live constants:", JSON.stringify(report.constants));

  // ---- per-clip luminance behaviour ----------------------------------------------------------
  console.log("\nclip                        meanY  minFrame  maxFrame  swing  darkestPx  brightestPx  maxΔ/frame");
  for (const c of CLIPS) {
    if (!existsSync(join(MEDIA, c.f))) { console.log(`${c.label}: missing`); continue; }
    await pushMedia(c.f, "video/mp4");
    const r = JSON.parse(await s.evaluate(SAMPLE_LUMA(5000)));
    report.clips.push({ ...c, ...r });
    console.log(`${c.label.padEnd(27)} ${String(r.meanLuma).padStart(5)} ${String(r.minFrameMean).padStart(9)} `
      + `${String(r.maxFrameMean).padStart(9)} ${String(r.frameMeanSwing).padStart(6)} ${String(r.darkestPixel).padStart(10)} `
      + `${String(r.brightestPixel).padStart(12)} ${String(r.maxFrameToFrameDelta).padStart(11)}`);
  }

  // ---- lifecycle events WITH video running ----------------------------------------------------
  console.log("\n=== lifecycle with 1080p30 video playing ===");
  await pushMedia("v1080p30.mp4", "video/mp4");
  await s.evaluate(`(() => { const desk=document.querySelector('.reader-desk');
    document.getElementById('__bgprobe')?.remove();
    const el=document.createElement('video'); el.id='__bgprobe';
    el.autoplay=true; el.loop=true; el.muted=true; el.playsInline=true; el.src=window.__mUrl;
    Object.assign(el.style,{position:'absolute',inset:'0',width:'100%',height:'100%',objectFit:'cover',zIndex:'0',pointerEvents:'none'});
    if (getComputedStyle(desk).position==='static') desk.style.position='relative';
    desk.insertBefore(el, desk.firstChild); window.__bgEl=el; return true; })()`);
  await sleep(1800);

  const measure = async (label, action) => {
    const m0 = (await s.send("Performance.getMetrics")).metrics.find((x) => x.name === "TaskDuration").value;
    await s.evaluate(`(() => { window.__lt=0; try { const po=new PerformanceObserver(l=>{window.__lt+=l.getEntries().length});
      po.observe({entryTypes:['longtask']}); window.__po=po; } catch(e){} return true; })()`);
    const t0 = Date.now();
    await action();
    await sleep(1500);
    const lt = await s.evaluate(`(() => { try { window.__po?.disconnect(); } catch(e){} return window.__lt; })()`);
    const m1 = (await s.send("Performance.getMetrics")).metrics.find((x) => x.name === "TaskDuration").value;
    const v = JSON.parse(await s.evaluate(`(() => { const v=window.__bgEl;
      return JSON.stringify({ playing: v && !v.paused, dropped: v?.getVideoPlaybackQuality?.().droppedVideoFrames ?? null }); })()`));
    const rec = { label, ms: Date.now() - t0, longTasks: lt, cpuMs: +((m1 - m0) * 1000).toFixed(0), ...v };
    report.lifecycle.push(rec);
    console.log(`  ${label.padEnd(26)} ${String(rec.ms).padStart(5)}ms  longTasks=${String(lt).padStart(2)}  cpu=${String(rec.cpuMs).padStart(4)}ms  videoPlaying=${rec.playing}  dropped=${rec.dropped}`);
  };

  await measure("theme switch (x3)", async () => {
    for (const t of ["night", "sepia", "normal"]) {
      await s.evaluate(`(() => { const b=document.querySelector('.pdf-chip-${t}'); if (b) b.click();
        document.documentElement.setAttribute('data-theme', ${JSON.stringify(t)}); return true; })()`);
      await sleep(500);
    }
  });
  await measure("immersive recede toggle", async () => {
    await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`);
    await sleep(600);
    await s.evaluate(`(() => { document.documentElement.classList.toggle('scrolled-away'); return true; })()`);
  });
  await measure("window resize (zoom proxy)", async () => {
    await s.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(800);
    await s.send("Emulation.clearDeviceMetricsOverride");
  });
  await measure("12 page turns", async () => {
    for (let i = 0; i < 12; i++) {
      await s.evaluate(`(async () => { try { await document.querySelector('.page-host foliate-view').next(); } catch(e){} })()`);
      await sleep(160);
    }
  });
  await measure("close + reopen book", async () => {
    await s.evaluate(`(() => { document.querySelector('.rc-back')?.click(); return true; })()`);
    await sleep(1800);
    await s.evaluate(`(() => { const c=[...document.querySelectorAll('.lib-card')][0]; if (c) c.click(); return !!c; })()`);
    await sleep(2500);
  });

  // is the media element still alive after a book close? (disposal question)
  report.afterReopen = JSON.parse(await s.evaluate(`(() => { const el=document.getElementById('__bgprobe');
    return JSON.stringify({ stillInDom: !!el, deskExists: !!document.querySelector('.reader-desk') }); })()`));
  console.log(`\n  after close+reopen: probe still in DOM = ${report.afterReopen.stillInDom} (the desk is re-created, so a real implementation must re-mount)`);

  await s.evaluate(`(() => { document.getElementById('__bgprobe')?.remove();
    if (window.__mUrl) URL.revokeObjectURL(window.__mUrl); window.__mUrl=null; window.__bgEl=null; return true; })()`);
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
