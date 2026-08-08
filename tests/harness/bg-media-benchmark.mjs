// INVESTIGATION TOOLING — animated reading-desk backgrounds (video / GIF). NOT production code.
//
// Measures what actually happens in Sard's own WebView2 when animated media is placed at the SAME
// layer the existing static background occupies (`.reader-desk::before` is a pseudo-element and cannot
// host a <video>, so the probe inserts a real element at the same z-position — see `install`).
//
// Media is synthetic (ffmpeg `testsrc2`), generated for this run. It is transferred into the page in
// base64 chunks and reassembled into a Blob, so no CSP host allowance and no profile mutation is
// needed. Every scenario is measured the same way and the page is restored between scenarios.
//
// What is measured per scenario, all from the real app:
//   * FPS and frame stability from a rAF sampler (p50 / p05 / worst frame gap)
//   * long tasks (PerformanceObserver 'longtask') — the thing a reader actually feels
//   * CPU proxy: CDP Performance.getMetrics TaskDuration delta over the window
//   * JS heap delta, LayoutCount / RecalcStyleCount deltas
//   * PAGE-TURN LATENCY while the media is running — the reading-critical number
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { launchSard } from "file:///M:/eRawy/tests/harness/cdp.mjs";
import { snapshotDb, restoreDb } from "file:///M:/eRawy/tests/harness/profile.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Where the sample clips live. They are tens of MB of video and GIF, deliberately not committed, so
// the location is a PARAMETER and never a constant:  --media=<dir>  |  $SARD_MEDIA_DIR  |  ./.media
// A machine-specific absolute path was hard-coded here once, which made the harness unrunnable
// anywhere but the one machine that wrote it — and put that machine's directory layout in the repo.
const MEDIA =
  process.argv.find((a) => a.startsWith("--media="))?.slice(8) ??
  process.env.SARD_MEDIA_DIR ??
  join(import.meta.dirname, ".media");
const OUT = "M:/eRawy/tests/harness/bg-media-benchmark-result.json";
const WINDOW_MS = 9000;

const SCENARIOS = [
  { id: "none", kind: "none", label: "no background (baseline)" },
  { id: "still1080.jpg", kind: "img", label: "static JPEG 1920x1080" },
  { id: "g480.gif", kind: "img", label: "GIF 854x480 @12fps" },
  { id: "g1080.gif", kind: "img", label: "GIF 1920x1080 @12fps" },
  { id: "v480p30.mp4", kind: "video", label: "H.264 854x480 @30" },
  { id: "v1080p30.mp4", kind: "video", label: "H.264 1920x1080 @30" },
  { id: "v1080p60.mp4", kind: "video", label: "H.264 1920x1080 @60" },
  { id: "v2160p30.mp4", kind: "video", label: "H.264 3840x2160 @30" },
  { id: "v1080p30.webm", kind: "video", label: "VP9 1920x1080 @30" },
];

const report = { startedAt: new Date().toISOString(), windowMs: WINDOW_MS, scenarios: [] };
const snap = snapshotDb("M:\\eRawy", "bg-media-bench");
if (!snap) { console.error("FATAL: snapshot failed"); process.exit(1); }

let s;
const metrics = async () => {
  const m = await s.send("Performance.getMetrics");
  const g = (n) => m.metrics.find((x) => x.name === n)?.value ?? 0;
  return { task: g("TaskDuration"), heap: g("JSHeapUsedSize"), layout: g("LayoutCount"),
    recalc: g("RecalcStyleCount"), nodes: g("Nodes"), docs: g("Documents") };
};

/** Push a file into the page as a Blob object URL, in chunks (CDP has practical expression limits). */
async function pushMedia(file, mime) {
  const b64 = readFileSync(join(MEDIA, file)).toString("base64");
  await s.evaluate(`window.__chunks = [];`);
  const CH = 700_000;
  for (let i = 0; i < b64.length; i += CH) {
    await s.evaluate(`window.__chunks.push(${JSON.stringify(b64.slice(i, i + CH))});`);
  }
  return s.evaluate(`(() => { const b64 = window.__chunks.join(''); window.__chunks = null;
    const bin = atob(b64); const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    if (window.__mediaUrl) URL.revokeObjectURL(window.__mediaUrl);
    window.__mediaUrl = URL.createObjectURL(new Blob([u8], { type: ${JSON.stringify(mime)} }));
    return window.__mediaUrl.slice(0, 24); })()`);
}

/** Insert the media as a full-bleed layer behind the page sheet, matching the existing bg position. */
const install = (kind) => `(() => {
  const desk = document.querySelector('.reader-desk'); if (!desk) return 'no desk';
  document.getElementById('__bgprobe')?.remove();
  if (${JSON.stringify(kind)} === 'none') return 'none';
  const el = document.createElement(${JSON.stringify(kind)} === 'video' ? 'video' : 'img');
  el.id = '__bgprobe';
  if (${JSON.stringify(kind)} === 'video') { el.autoplay = true; el.loop = true; el.muted = true;
    el.playsInline = true; el.setAttribute('muted',''); }
  el.src = window.__mediaUrl;
  Object.assign(el.style, { position: 'absolute', inset: '0', width: '100%', height: '100%',
    objectFit: 'cover', zIndex: '0', pointerEvents: 'none' });
  const cs = getComputedStyle(desk);
  if (cs.position === 'static') desk.style.position = 'relative';
  desk.insertBefore(el, desk.firstChild);
  window.__bgEl = el;
  return el.tagName;
})()`;

const SAMPLER = `(() => {
  window.__fps = { gaps: [], long: 0, longMs: 0, stop: false };
  try { const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) {
      window.__fps.long++; window.__fps.longMs += e.duration; } });
    po.observe({ entryTypes: ['longtask'] }); window.__fps.po = po; } catch (e) {}
  let last = performance.now();
  const tick = (t) => { if (window.__fps.stop) return; window.__fps.gaps.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick); return true;
})()`;

const HARVEST = `(() => { window.__fps.stop = true; try { window.__fps.po?.disconnect(); } catch(e) {}
  const g = window.__fps.gaps.slice(3).sort((a,b) => a-b);
  const q = (p) => g.length ? +g[Math.min(g.length-1, Math.floor(g.length*p))].toFixed(2) : null;
  const v = window.__bgEl && window.__bgEl.tagName === 'VIDEO' ? window.__bgEl : null;
  return JSON.stringify({ frames: g.length, medianGap: q(0.5), p95Gap: q(0.95), worstGap: g.length ? +g[g.length-1].toFixed(2) : null,
    fps: g.length ? +(1000 / (g[Math.floor(g.length/2)] || 16.7)).toFixed(1) : null,
    longTasks: window.__fps.long, longMs: +window.__fps.longMs.toFixed(1),
    video: v ? { w: v.videoWidth, h: v.videoHeight, dropped: v.getVideoPlaybackQuality?.().droppedVideoFrames ?? null,
      total: v.getVideoPlaybackQuality?.().totalVideoFrames ?? null, paused: v.paused, err: v.error?.code ?? null } : null }); })()`;

try {
  s = await launchSard({ exe: "test-build/Sard.exe", port: 9961, timeoutMs: 90_000 });
  if (s.skipped) throw new Error(s.skipped);
  await s.send("Performance.enable");
  for (let i = 0; i < 150; i++) { if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) break; await sleep(400); }
  for (let i = 0; i < 80; i++) { if (await s.evaluate(`document.querySelectorAll('.lib-card').length > 0`)) break; await sleep(400); }

  // ---- codec support, straight from the engine -------------------------------------------------
  report.codecs = JSON.parse(await s.evaluate(`(() => { const v = document.createElement('video');
    const t = (s) => v.canPlayType(s) || 'no';
    return JSON.stringify({
      h264: t('video/mp4; codecs="avc1.42E01E"'), hevc: t('video/mp4; codecs="hvc1"'),
      vp8: t('video/webm; codecs="vp8"'), vp9: t('video/webm; codecs="vp09.00.10.08"'),
      av1: t('video/mp4; codecs="av01.0.05M.08"'), theora: t('video/ogg; codecs="theora"'),
      hwDecode: (() => { try { const c = document.createElement('canvas').getContext('webgl2');
        const d = c?.getExtension('WEBGL_debug_renderer_info');
        return d ? c.getParameter(d.UNMASKED_RENDERER_WEBGL) : null; } catch(e) { return null; } })(),
      dpr: window.devicePixelRatio, ua: navigator.userAgentData?.brands?.map(b=>b.brand+' '+b.version).join(', ') ?? navigator.appVersion.slice(0,40),
    }); })()`));
  console.log("codecs:", JSON.stringify(report.codecs, null, 1));

  // open an EPUB so the reading desk and pagination exist
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
  console.log(`\nhost book: "${epub.title}"\n`);
  console.log("scenario                        fps  medGap  p95Gap  worst  longTasks  cpu_ms  heapMB  turn_p50  turn_p95  dropped");

  for (const sc of SCENARIOS) {
    if (sc.kind !== "none") {
      const f = join(MEDIA, sc.id);
      if (!existsSync(f)) { console.log(`${sc.label}: media missing`); continue; }
      const mime = sc.id.endsWith(".mp4") ? "video/mp4" : sc.id.endsWith(".webm") ? "video/webm"
        : sc.id.endsWith(".gif") ? "image/gif" : "image/jpeg";
      await pushMedia(sc.id, mime);
    }
    await s.evaluate(install(sc.kind));
    await sleep(1800); // let decode/playback reach steady state before sampling

    const m0 = await metrics();
    await s.evaluate(SAMPLER);
    await sleep(WINDOW_MS);
    const h = JSON.parse(await s.evaluate(HARVEST));
    const m1 = await metrics();

    // page-turn latency WHILE the media runs.
    // Reset to an early section first: running off the end of the book makes `next()` throw inside the
    // paginator, which aborted the first version of this run after five scenarios.
    await s.evaluate(`(async () => { const v=document.querySelector('.page-host foliate-view');
      try { await v.goTo(4); } catch(e) {} return true; })()`);
    await sleep(1400);
    const turns = [];
    for (let i = 0; i < 12; i++) {
      const t = await s.evaluate(`(async () => { const v = document.querySelector('.page-host foliate-view');
        const t0 = performance.now();
        try { await v.next(); } catch (e) { return -1; }
        return +(performance.now() - t0).toFixed(1); })()`);
      if (t >= 0) turns.push(t);
      await sleep(220);
    }
    if (!turns.length) turns.push(-1);
    turns.sort((a, b) => a - b);
    const p = (q) => turns[Math.min(turns.length - 1, Math.floor(turns.length * q))];

    const rec = { ...sc, ...h, cpuMs: +((m1.task - m0.task) * 1000).toFixed(0),
      heapMB: +((m1.heap - m0.heap) / 1048576).toFixed(1),
      layoutDelta: m1.layout - m0.layout, recalcDelta: m1.recalc - m0.recalc,
      turnP50: p(0.5), turnP95: p(0.95) };
    report.scenarios.push(rec);
    console.log(`${sc.label.padEnd(30)} ${String(h.fps).padStart(5)} ${String(h.medianGap).padStart(7)} `
      + `${String(h.p95Gap).padStart(7)} ${String(h.worstGap).padStart(6)} ${String(h.longTasks).padStart(10)} `
      + `${String(rec.cpuMs).padStart(7)} ${String(rec.heapMB).padStart(7)} ${String(rec.turnP50).padStart(9)} `
      + `${String(rec.turnP95).padStart(9)} ${String(h.video?.dropped ?? "-").padStart(8)}`);
    if (h.video?.err) console.log(`    video error code ${h.video.err}`);
  }

  // ---- TTS + 1080p video together --------------------------------------------------------------
  console.log("\n=== TTS active + 1080p30 video ===");
  await pushMedia("v1080p30.mp4", "video/mp4");
  await s.evaluate(install("video"));
  await sleep(1500);
  await s.evaluate(`(() => { const b=[...document.querySelectorAll('.rc-btn')]
    .find(x=>/listen|استماع|قراءة/i.test((x.getAttribute('title')||''))); if (b) b.click(); return !!b; })()`);
  let tts = null; const dl = Date.now() + 60_000;
  while (Date.now() < dl) {
    tts = JSON.parse(await s.evaluate(`(() => { const q=window.__sardTtsStore?.getState?.();
      let m=null; try { m=window.__sardTtsStats?.().media ?? null; } catch(e){}
      return JSON.stringify({ status:q?.status, underruns:q?.underruns, readyState:m?m.readyState:null, paused:m?m.paused:null }); })()`));
    if (tts.readyState === 4) break;
    if (tts.status === "error") break;
    await sleep(800);
  }
  const m0 = await metrics(); await s.evaluate(SAMPLER); await sleep(WINDOW_MS);
  const h = JSON.parse(await s.evaluate(HARVEST)); const m1 = await metrics();
  const ttsAfter = JSON.parse(await s.evaluate(`(() => { const q=window.__sardTtsStore?.getState?.();
    return JSON.stringify({ status:q?.status, underruns:q?.underruns, abandoned:q?.abandoned }); })()`));
  report.ttsWithVideo = { start: tts, after: ttsAfter, ...h, cpuMs: +((m1.task - m0.task) * 1000).toFixed(0) };
  console.log(`  tts=${ttsAfter.status} underruns=${ttsAfter.underruns} abandoned=${ttsAfter.abandoned} · fps=${h.fps} longTasks=${h.longTasks} droppedFrames=${h.video?.dropped}`);
  await s.evaluate(`try { window.__sardTtsStore.getState().stop(); } catch(e){}`);

  // teardown
  await s.evaluate(`(() => { document.getElementById('__bgprobe')?.remove();
    if (window.__mediaUrl) URL.revokeObjectURL(window.__mediaUrl); window.__mediaUrl=null; window.__bgEl=null; return true; })()`);
  report.leftover = await s.evaluate(`!!document.getElementById('__bgprobe')`);
  report.pageErrors = JSON.parse(await s.evaluate(`JSON.stringify((window.__err||[]).slice(0,8))`));
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
