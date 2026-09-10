// UPGRADING FROM BEFORE هيئات EXISTED — the compatibility path, guarded.
//
// THE LOSS THIS EXISTS TO PREVENT. A reader who customised Sard before this system arrived has all of
// it persisted (`reading_style`, the two papers, the background bindings, the interface font, the
// bookmark) and ZERO هيئات. The first هيئة they wear calls `readingPatch`, whose contract is that a
// هيئة is a COMPLETE look — it asserts what it names and CLEARS what it does not — and the values it
// clears are, for this reader, years of their own settings with no copy anywhere. The guard that would
// normally ask (`guardUnsaved`) compares the ACTIVE هيئة against the screen, and with `activeId` null
// there is nothing to compare, so the switch proceeds in silence.
//
// The behaviour is proved end to end against a real pre-هيئة database by the harness. What is held
// here is the SHAPE, because the two properties that make it safe are invisible at runtime once they
// work: that it can only ever run once, and that it captures the measure rather than declining to.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const STORE = readFileSync(
  join(import.meta.dirname, "..", "..", "src/features/profiles/store.ts"),
  "utf8",
);

describe("the look a reader already had", () => {
  it("is captured WITH the measure, unlike an ordinary capture", () => {
    // `captureCurrent` deliberately takes no typography, read-aloud or reference opinion — right for
    // "make a هيئة from how Sard looks", and fatal here, because the measure is the largest part of
    // what a pre-هيئة reader customised. If this ever went back to a bare `captureCurrent()` the
    // migration would still create a هيئة and still lose the settings it exists to save.
    expect(STORE).toContain("export async function captureLegacyLook()");
    for (const list of ["TYPOGRAPHY_KEYS", "VOICE_KEYS", "REF_KEYS"]) {
      expect(STORE, list).toMatch(new RegExp(list + "\\.map"));
    }
    expect(STORE).toContain("numbers: live.numberColor ?? null");
  });

  it("asks whether anything would be lost using the list of what a هيئة overwrites", () => {
    // Not an invented list of keys: `PROFILE_WRITES` IS what activation writes over, so "what would be
    // lost" and "what is checked" are one list and cannot drift apart.
    expect(STORE).toContain("const keys = [...PROFILE_WRITES.filter((k) => k !== \"profile_active\"), READING_KEY];");
  });

  it("can only run once — against a restart AND against a concurrent second caller", () => {
    // TWO INDEPENDENT GUARDS, and both were needed. The marker row stops a later launch. The
    // single-flight promise stops the SAME launch running it twice, which is not hypothetical: it was
    // measured — `initProfiles` runs twice, both calls read the marker before either wrote it, and the
    // reader's look was captured into two هيئات with one name.
    expect(STORE).toContain("let legacyRun: Promise<Profile | null> | null = null;");
    expect(STORE).toContain("if (!legacyRun) legacyRun = runLegacyCapture(profiles);");
    expect(STORE).toContain('const LEGACY_KEY = "profiles_legacy_captured";');
    // The marker is written for the never-customised reader too, so the probe does not re-run forever.
    expect(STORE).toMatch(/if \(!\(await hasLegacyLook\(\)\)\) \{\s*await settingsSet\(LEGACY_KEY, "none"\)/);
  });

  it("only ever runs for a reader who has NO هيئات", () => {
    expect(STORE).toContain("if (profiles.length > 0) return null;");
    // …and re-reads the list rather than trusting the caller's snapshot.
    expect(STORE).toContain("if ((live ?? []).length > 0) return null;");
  });

  it("leaves the reader WEARING it, which is what brings them inside the guard", () => {
    // Wearing it changes nothing on screen — the هيئة is the look it was captured from — and from that
    // moment `guardUnsaved` has an active هيئة to compare, so the NEXT switch stops and asks.
    expect(STORE).toContain("await applyProfile(made, { worn: false });");
  });

  it("runs after the reading row has been primed, or it would capture nothing", () => {
    // `captureLegacyLook` reads the measure through `peekGlobalStyle`, which is a cache `primeGlobalStyle`
    // fills. Called before it, every typography field would capture as null — a هيئة that looks like a
    // rescue and holds none of the settings.
    const prime = STORE.indexOf("await primeGlobalStyle().catch(() => {});");
    const call = STORE.indexOf("await materialiseLegacyLook(profiles)");
    expect(prime).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(prime);
  });
});

// ==================================================================================================
// THE CAPTURE CAN ONLY SEE WHAT HAS BEEN LOADED
// ==================================================================================================
//
// THE TESTER'S FAILURE. A reader upgraded with a customised look. «هيئتك السابقة» was created, the
// background survived — and the chrome went to Ivory. Measured against a complete fixture on the
// build that shipped it:
//
//     field            legacy value            captured
//     chrome           trueblack  #0E0E0E      #EAE0CA   ← ivory
//     paper            sepia      #E8D9BC      #F5EEDD   ← ivory
//     bookmark pos     spine                   0.84      ← store default
//     bookmark size    lg                      68        ← store default
//     read marker      dot                     accentTrail ← store default
//     interface font   Tahoma                  Tahoma    ✓ (won the race)
//     background       bound                   bound     ✓ (won the race)
//
// `captureCurrent` reads the LIVE STORES, and `App.tsx` starts them without awaiting — and sequences
// `initTheme` AFTER `initProfiles` on purpose, so the theme store is not merely likely to be
// unloaded at capture time: it is GUARANTEED to be. `useTheme` is constructed with
// `themeId: DEFAULT_LIGHT`, and `DEFAULT_LIGHT` is «ivory». The capture then recorded Ivory and
// `applyProfile` wrote it back over the reader's real `theme_id` — destroying the setting the
// migration exists to rescue. The fields that survived did so only by winning a race.
//
// WHY THIS TEST IS SHAPED THIS WAY. A test that checked "is the theme captured?" would have been
// written from the same list of fields the capture already knew about, and would have missed this
// exactly as the old tests did. So it asserts the RULE instead: every store `captureCurrent` reads
// must be loaded before the capture runs. Add a sixth store to `captureCurrent` and this fails until
// it is hydrated too — which is the property that was missing, not any particular field.
describe("the legacy capture reads loaded state, not constructed defaults", () => {
  /** The stores `captureCurrent` actually reads, taken from the function rather than from a list. */
  const capture = STORE.slice(
    STORE.indexOf("export async function captureCurrent()"),
    STORE.indexOf("export async function captureCurrent()") + 2600,
  );
  const SOURCES: Array<[store: string, loader: string]> = [
    ["useTheme.getState()", "initTheme()"],
    ["useFonts.getState()", "initFonts()"],
    ["useBookmarkStyle.getState()", "initBookmarkStyle()"],
    ["useReadMarkerStyle.getState()", "initReadMarkerStyle()"],
    ["useBackground.getState()", "initBackground()"],
  ];

  /** The legacy capture's own body — the only place this hydration is owed. */
  const legacy = STORE.slice(
    STORE.indexOf("async function runLegacyCapture"),
    STORE.indexOf("async function runLegacyCapture") + 3600,
  );

  it("knows which stores the capture depends on", () => {
    // If this fails, `captureCurrent` grew a source and the pairing below is out of date — which is
    // the moment to hydrate it, not to relax the assertion.
    for (const [store] of SOURCES) {
      expect(capture, `captureCurrent reads ${store}`).toContain(store);
    }
  });

  it("loads every one of them before capturing", () => {
    // The whole defect in one assertion.
    for (const [store, loader] of SOURCES) {
      expect(legacy, `${store} is loaded by ${loader} before the capture`).toContain(loader);
    }
  });

  it("waits for them, rather than merely starting them", () => {
    // `App.tsx` starts these without awaiting, which is what made the surviving fields a race. The
    // capture cannot be a race: it reads once and the answer is written to disk.
    const at = legacy.indexOf("await Promise.all([");
    expect(at, "the loaders are awaited together").toBeGreaterThan(-1);
    const block = legacy.slice(at, legacy.indexOf("]);", at));
    for (const [, loader] of SOURCES) {
      expect(block, `${loader} is inside the awaited batch`).toContain(loader);
    }
  });

  it("hydrates BEFORE the capture, not after it", () => {
    const hydrate = legacy.indexOf("await Promise.all([");
    const capturedAt = legacy.indexOf("await captureLegacyLook()");
    expect(hydrate).toBeGreaterThan(-1);
    expect(capturedAt).toBeGreaterThan(hydrate);
  });

  it("does it only for the reader who is actually being migrated", () => {
    // Ordered so a reader with هيئات, or a genuinely new one, never pays for the loads: the
    // preconditions and the `hasLegacyLook` probe all come first.
    const noProfiles = legacy.indexOf("if (profiles.length > 0) return null;");
    const marker = legacy.indexOf("if (done) return null;");
    const probe = legacy.indexOf("if (!(await hasLegacyLook()))");
    const hydrate = legacy.indexOf("await Promise.all([");
    for (const [name, at] of [["profiles precondition", noProfiles], ["marker", marker], ["legacy probe", probe]] as const) {
      expect(at, name).toBeGreaterThan(-1);
      expect(hydrate, `hydration comes after the ${name}`).toBeGreaterThan(at);
    }
  });

  it("the theme is the one that could never have worked, and is named", () => {
    // `initTheme` is sequenced AFTER `initProfiles` in App.tsx by design, so unlike the others this
    // was not a race — it was certain. The comment records that so the ordering is not "simplified"
    // back later.
    expect(legacy).toContain("initTheme()");
    expect(STORE).toMatch(/DEFAULT_LIGHT.*ivory|ivory.*DEFAULT_LIGHT/is);
  });
});
