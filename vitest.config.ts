import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// WP-0 (RESILIENCE-1): the project's first JavaScript test runner.
//
// Environment is `node`, deliberately. The three packages that will use this runner first (WP-1's
// error classifier, WP-3's metadata resolver, WP-5's TTS language matrix) are all PURE modules with
// no DOM — the same property that makes `lib/ttsScheduler.ts` testable. Real DOM/layout questions
// (WP-4's chevron geometry, WP-7's cascade) cannot be answered by jsdom/happy-dom at all: they need
// the actual engine, which these unit tests deliberately do not attempt. Adding a DOM shim now would buy nothing
// and would invite tests that pass in a fake DOM and lie about WebView2.
export default defineConfig({
  // THE INSTRUMENTATION SPECIFIERS, pointed at the REAL modules.
  //
  // Product code imports `@diag`, `@pdfDiag` and `@renderDiag` so that the production tree — which
  // excludes the instrumentation — can fall back to `diagOff.ts` (see tsconfig.json and
  // vite.config.ts). Vitest resolves through neither of those, so without this a test that imports
  // any product module fails with "Cannot find package '@pdfDiag'".
  //
  // These point at the REAL modules, not the stub, and deliberately: the suite runs against the full
  // development tree and should exercise the code that actually runs there, exactly as `tsc` does on
  // this branch. A test passing against a no-op would be a test that had stopped testing.
  resolve: {
    alias: {
      // The real instrumentation is private and local-only, so the public tree resolves these to the
      // no-op stub — the same file the production bundle uses. Tests must not depend on a module that
      // is not in the repository.
      "@diag": resolve(import.meta.dirname, "src/lib/diagOff.ts"),
      "@pdfDiag": resolve(import.meta.dirname, "src/lib/diagOff.ts"),
      "@renderDiag": resolve(import.meta.dirname, "src/lib/diagOff.ts"),
    },
  },
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
