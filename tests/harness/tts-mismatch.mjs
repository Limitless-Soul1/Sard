#!/usr/bin/env node
// RESILIENCE-1 / WP-5 — MEASUREMENT M1.
//
// THE QUESTION THE PLAN COULD NOT ANSWER STATICALLY: what does the Edge endpoint actually do when a
// voice's locale does not match the text's script? Empty audio? An explicit rejection? A 4xx?
//
// WHY IT MATTERS, precisely. WP-5A gates BEFORE synthesis, so the wire behaviour is irrelevant to it.
// WP-5B is the safety net for whatever slips past the gate, and a safety net matched to a guess is
// worse than none: if Edge returns *audio* for a mismatch, there is no error to classify and 5B must
// not pretend otherwise; if it returns a 4xx, `isPermanentFailure` ALREADY catches it and 5B would be
// dead code; only an error that is neither gives 5B something real to do.
//
// This performs ONE live synthesis per pair through Sard's own IPC — the same call Play makes — and
// reports exactly what came back. It needs the network, and it is a read-only probe: no session is
// started, nothing is persisted, and no audio is played.
//
//   node tests/harness/tts-mismatch.mjs
//
// ⚠ Drives the REAL app against the REAL profile — same snapshot/restore contract as the others.

import { join } from "node:path";
import { launchSard } from "./cdp.mjs";
import { snapshotDb, restoreDb } from "./profile.mjs";

const REPO = join(import.meta.dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AR = "السلام عليكم ورحمة الله وبركاته، هذا نص عربي للاختبار.";
const EN = "Hello, this is an English sentence used for the compatibility probe.";
const FR = "Bonjour, ceci est une phrase française pour la sonde de compatibilité.";

// Each case names what it is meant to isolate, so a surprising result is interpretable.
const CASES = [
  { name: "en voice + ARABIC text  (the reported mismatch)", voice: "en-US-AriaNeural", text: AR },
  { name: "ar voice + ENGLISH text (the mirror case)", voice: "ar-EG-SalmaNeural", text: EN },
  { name: "en voice + english text (control: must work)", voice: "en-US-AriaNeural", text: EN },
  { name: "ar voice + arabic text  (control: must work)", voice: "ar-EG-SalmaNeural", text: AR },
  { name: "multilingual + ARABIC   (must work by design)", voice: "en-AU-WilliamMultilingualNeural", text: AR },
  { name: "nonexistent voice       (the known permanent class)", voice: "xx-XX-NotARealNeural", text: EN },
  // Does the pattern generalise, or is it a quirk of one voice pair? These decide whether the rule
  // should be about SCRIPT (what a voice can render) or about LANGUAGE (what it speaks well).
  { name: "fr voice + ARABIC text  (another non-Arabic voice)", voice: "fr-FR-DeniseNeural", text: AR },
  { name: "de voice + ARABIC text  (a third non-Arabic voice)", voice: "de-DE-KatjaNeural", text: AR },
  { name: "en voice + FRENCH text  (Latin vs Latin — should be fine)", voice: "en-US-AriaNeural", text: FR },
  { name: "ar voice + FRENCH text  (Arabic voice, Latin text)", voice: "ar-EG-SalmaNeural", text: FR },
];

async function waitForIpc(s) {
  for (let i = 0; i < 80; i++) {
    if (await s.evaluate(`typeof window.__TAURI_INTERNALS__?.invoke === 'function'`)) return true;
    await sleep(400);
  }
  throw new Error("IPC never appeared");
}

const snap = snapshotDb(REPO, "ttsmm");
console.log(`\n  db snapshot: ${snap}`);
let sard;
try {
  sard = await launchSard({ port: 9338 });
  if (sard.skipped) { await restoreDb(snap); console.error(sard.skipped); process.exit(1); }
  const s = sard;
  await waitForIpc(s);

  // Confirm the voices actually exist in THIS region's list before drawing conclusions from a
  // failure — Microsoft's CDN varies by geography (RAWY-179), so "voice not found" here would be a
  // property of the region, not of the mismatch.
  const voices = await s.evaluate(
    `window.__TAURI_INTERNALS__.invoke('tts_edge_voices').then(v => v.map(x => x.id)).catch(e => 'ERR: ' + e)`,
  );
  if (typeof voices === "string") {
    console.error(`\n  could not list Edge voices: ${voices}\n  (no network? then M1 cannot be answered now)\n`);
  } else {
    console.log(`  edge voices available: ${voices.length}`);
    for (const c of CASES) {
      c.present = voices.includes(c.voice);
    }
  }

  console.log("\n  case                                              present  outcome");
  console.log("  " + "-".repeat(96));
  for (const c of CASES) {
    const r = await s.evaluate(
      `window.__TAURI_INTERNALS__.invoke('tts_synthesize', {
          engine: 'edge', id: ${JSON.stringify(c.voice)}, text: ${JSON.stringify(c.text)} })
        .then(buf => ({ ok: true, bytes: (buf && buf.byteLength) || (buf && buf.length) || 0 }))
        .catch(e => ({ ok: false, error: String(e && e.message ? e.message : e) }))`,
    );
    const outcome = r.ok
      ? `AUDIO — ${r.bytes} bytes`
      : `ERROR — ${String(r.error).slice(0, 70)}`;
    console.log(`  ${c.name.padEnd(48)}  ${String(c.present ?? "?").padEnd(7)}  ${outcome}`);
    await sleep(600); // one connection is reused; do not hammer the endpoint
  }
  // WP-5A/B END-TO-END: does the SHIPPING rule agree with what the endpoint just did? Evaluated
  // through the product's own module (a debug surface, same convention as __sardTtsStats), so this
  // cannot pass while the code that actually runs disagrees.
  const gate = await s.evaluate(
    `(() => {
       const m = window.__sardVoiceCompat;
       if (!m) return { error: 'no __sardVoiceCompat hook' };
       return {
         en_ar: m.voiceCompatibility('arabic', { id: 'en-US-AriaNeural', lang: 'en-US' }),
         fr_ar: m.voiceCompatibility('arabic', { id: 'fr-FR-DeniseNeural', lang: 'fr-FR' }),
         ar_ar: m.voiceCompatibility('arabic', { id: 'ar-EG-SalmaNeural', lang: 'ar-EG' }),
         ar_latin: m.voiceCompatibility('latin', { id: 'ar-EG-SalmaNeural', lang: 'ar-EG' }),
         multi_ar: m.voiceCompatibility('arabic', { id: 'en-AU-WilliamMultilingualNeural', lang: 'en-AU' }),
         net_6: m.isImplausiblyShortAudio('نص', 6),
         net_28k: m.isImplausiblyShortAudio('hello', 28676),
       };
     })()`,
  );
  console.log("\n  the SHIPPING rule, evaluated inside the app:");
  if (gate.error) {
    console.log(`    ${gate.error}`);
  } else {
    for (const [k, val] of Object.entries(gate)) console.log(`    ${k.padEnd(10)} ${val}`);
    const want = {
      en_ar: "incompatible", fr_ar: "incompatible", ar_ar: "compatible",
      ar_latin: "compatible", multi_ar: "universal", net_6: true, net_28k: false,
    };
    const bad = Object.entries(want).filter(([k, val]) => gate[k] !== val);
    console.log(bad.length ? `\n  ✗ the shipping rule disagrees with the measurements: ${JSON.stringify(bad)}\n`
                           : `\n  ✓ the shipping rule matches every measured outcome above\n`);
  }
  console.log(
    "  READ THIS AS: 'AUDIO' for a mismatched pair means there is NO error to classify —\n" +
      "  only a pre-flight gate (WP-5A) can catch it, and WP-5B matches the empty buffer instead.\n",
  );
} finally {
  if (sard) await sard.close();
  await restoreDb(snap);
  console.log("  db restored from snapshot (profile untouched)\n");
}
