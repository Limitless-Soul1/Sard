import { defineConfig } from "vitest/config";

// WP-0 (RESILIENCE-1): the project's first JavaScript test runner.
//
// Environment is `node`, deliberately. The three packages that will use this runner first (WP-1's
// error classifier, WP-3's metadata resolver, WP-5's TTS language matrix) are all PURE modules with
// no DOM — the same property that makes `lib/ttsScheduler.ts` testable. Real DOM/layout questions
// (WP-4's chevron geometry, WP-7's cascade) cannot be answered by jsdom/happy-dom at all: they need
// the actual engine, which is what `tests/harness/` is for. Adding a DOM shim now would buy nothing
// and would invite tests that pass in a fake DOM and lie about WebView2.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // `public/foliate-js` is a VENDORED engine pinned at a commit (see public/foliate-js/VENDOR.txt).
    // It is never linted, never tested and never edited except through a recorded local patch.
    exclude: ["node_modules/**", "dist/**", "src-tauri/**", "public/**", "test-build/**"],
    // The fixture generator and the corpus tooling write to disk; give them room without letting a
    // genuinely hung harness sit forever.
    testTimeout: 30_000,
    reporters: "default",
  },
});
