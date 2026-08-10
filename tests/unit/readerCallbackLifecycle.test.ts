// Every reader callback must be registered when the controller EXISTS, not when the component mounts.
//
// WHY THIS EXISTS. On the hosted path the controller is created asynchronously, so it is `null` while
// the reader's mount-time effects run. A ref is invisible to React — filling it in re-runs nothing —
// so those effects ran once against `null` and never again. MEASURED on real WebKitGTK, in the real
// application: all three registration sites reported `ctrlPresent: false`, and a genuine drag across
// the rendered text produced no selection event at all. Nine of the ten callbacks were dead; only
// `onRelocate` worked, because it is registered inside `openBook` after the controller is bound.
//
// The fix is a `readerReady` value in the dependency arrays. This guard is what stops it being
// removed, and what catches the next callback added to a mount-time effect without it.
//
// WHAT IT CANNOT PROVE: that registration actually happens at run time. The suite runs on Node with
// no DOM, deliberately (see vitest.config.ts — a DOM shim "would invite tests that pass in a fake DOM
// and lie about WebView2"). Runtime proof comes from driving the real application on WebKitGTK.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = [
  join("src", "features", "reader", "Reader.tsx"),
  join("src", "features", "reader", "AnnotationLayer.tsx"),
];

/** The callbacks that were dead on the hosted path. `onRelocate` is deliberately absent — see below. */
const REGISTERED_IN_EFFECTS = [
  "onSelection",
  "onShowAnnotation",
  "onReferenceHit",
  "onActivity",
  "onSpace",
  "onArrow",
  "onScrollIntent",
  "onZoomIntent",
  "onReadingRedraw",
] as const;

/**
 * The dependency array of the `useEffect` a position sits inside.
 *
 * Found by scanning forward to the effect's closing `}, [ … ]);`, which is how every effect in these
 * files is written. Returns null when there is no such closing, which the assertions treat as a
 * failure rather than a pass — an unparsed effect must not look like a satisfied one.
 */
function depsAfter(source: string, from: number): string | null {
  const close = source.indexOf("}, [", from);
  if (close < 0) return null;
  const end = source.indexOf("]", close);
  return end < 0 ? null : source.slice(close + 3, end + 1);
}

describe("reader callbacks are registered when the controller exists", () => {
  const sources = new Map(FILES.map((f) => [f, readFileSync(f, "utf8")]));

  it("finds the registration sites at all", () => {
    // A guard on the guard: if the registrations move or are renamed, every assertion below would
    // pass vacuously against nothing.
    const all = [...sources.values()].join("\n");
    for (const cb of REGISTERED_IN_EFFECTS) {
      expect(all, `${cb} is not registered anywhere any more`).toContain(`${cb}(`);
    }
  });

  it("every one of them sits in an effect that depends on readerReady", () => {
    const missing: string[] = [];
    for (const [file, src] of sources) {
      for (const cb of REGISTERED_IN_EFFECTS) {
        const at = src.indexOf(`${cb}(`);
        if (at < 0) continue;
        const deps = depsAfter(src, at);
        if (deps === null) {
          missing.push(`${file}:${cb} — could not find the effect's dependency array`);
        } else if (!deps.includes("readerReady")) {
          missing.push(`${file}:${cb} — deps ${deps} do not include readerReady`);
        }
      }
    }
    expect(
      missing,
      "these callbacks are registered in an effect that cannot re-run when the hosted controller " +
        "arrives, so they will be dead on Linux exactly as onSelection was",
    ).toEqual([]);
  });

  it("onRelocate is left alone, because it never had the problem", () => {
    // It is registered inside `openBook`, after the controller is bound — which is precisely why it
    // kept working while the other nine did not. Moving it would be change for its own sake.
    const reader = sources.get(FILES[0])!;
    const at = reader.indexOf("onRelocate(");
    expect(at).toBeGreaterThan(0);
    expect(reader.slice(at - 400, at)).toContain("ctrlRef.current!");
  });

  it("registration replaces rather than accumulates", () => {
    // Why a re-run cannot register a callback twice: the controller ASSIGNS each one. If any of these
    // ever became a list, a re-render would start delivering duplicate events.
    const engine = readFileSync(join("src", "reader-engine", "FoliateController.ts"), "utf8");
    for (const cb of REGISTERED_IN_EFFECTS) {
      const at = engine.indexOf(`  ${cb}(cb`);
      if (at < 0) continue; // registered on the transport instead; covered by its own assignment
      const body = engine.slice(at, at + 200);
      expect(body, `${cb} must assign its callback, not append it`).toMatch(/=\s*cb;/);
      expect(body).not.toMatch(/\.push\(cb\)/);
    }
  });
});
