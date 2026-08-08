// The production-content gate's matcher, tested directly.
//
// This scanner is what stands between an internal file and a public release, so it needs the same
// treatment as any other gate: prove it FIRES on the things that actually reached v1.2.2, and prove it
// STAYS SILENT on the things that legitimately ship. A scanner that only ever passes is indistinguishable
// from no scanner at all, and one that cries wolf gets switched off.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM module, no type declarations
import { scanText, scanPackageJson, isVendored } from "../../scripts/production-content-rules.mjs";

type Violation = { rule: string; why: string; line: number; text: string };
const rules = (path: string, text: string): string[] =>
  (scanText(path, text) as Violation[]).map((v) => v.rule);

describe("production content — must FIRE on what actually contaminated v1.2.2", () => {
  it("catches the hardcoded vault path from corpus_tests.rs", () => {
    const src = `let p = PathBuf::from(env::var("SARD_CORPUS").unwrap_or_else(|_| "M:\\\\ProjectDocs\\\\sard\\\\Corpus".into()));`;
    const hits = rules("src-tauri/src/books/corpus_tests.rs", src);
    expect(hits).toContain("private-path");
    expect(hits).toContain("private-infrastructure");
  });

  it("catches a user-specific Windows path", () => {
    expect(rules("src/lib/x.ts", `const p = "C:\\\\Users\\\\Administrator\\\\AppData\\\\Local";`)).toContain("private-path");
  });

  it("catches any non-C drive letter", () => {
    expect(rules("src/lib/x.ts", `// see M:/eRawy/notes`)).toContain("private-path");
  });

  it("catches references to the private repository and workspaces", () => {
    expect(rules("README.md", "push to Sard-develop first")).toContain("private-infrastructure");
    expect(rules("README.md", "plans live in M:\\Sard Mobile\\INDEX.md")).toContain("private-infrastructure");
  });

  it("catches references to real personal data", () => {
    expect(rules("src-tauri/src/library/mod.rs", "// the owner's library holds a stray title")).toContain("personal-data");
    expect(rules("scripts/x.mjs", "const d = '.db-snapshot-2026';")).toContain("personal-data");
  });

  it("catches development tooling names", () => {
    expect(rules("BUILD.md", "run `npm run build:test`, or scripts/build-test.mjs")).toContain("dev-tooling");
    expect(rules("src/lib/x.ts", "// measured by the byte-identity harness")).toContain("dev-tooling");
    expect(rules("vite.config.ts", "// set by scripts/pack-diag.mjs")).toContain("dev-tooling");
  });

  it("catches references to internal engineering documents", () => {
    expect(rules("README.md", "see docs/engineering/WORKFLOW.md")).toContain("internal-docs");
    expect(rules("src/x.ts", "// per CHECKPOINT-2026-08-07")).toContain("internal-docs");
    expect(rules("src/x.ts", "// see PDF_TTS_INVESTIGATION.md")).toContain("internal-docs");
  });

  it("catches references to test infrastructure that does not ship", () => {
    expect(rules("src/features/reader/Reader.tsx", "// see tests/harness/tts-track.mjs")).toContain("test-infrastructure");
  });

  it("catches a Rust test module by its path alone", () => {
    expect(rules("src-tauri/src/books/wp2_tests.rs", "fn main() {}")).toContain("test-module");
    expect(rules("src-tauri/src/books/compat/tests.rs", "fn main() {}")).toContain("test-module");
  });

  it("catches credential-shaped strings", () => {
    expect(rules("src/x.ts", `const apiKey = "abcd1234efgh5678";`)).toContain("secret");
    expect(rules("k.pem", "-----BEGIN RSA PRIVATE KEY-----")).toContain("secret");
  });

  it("catches assistant, model and generation attribution", () => {
    expect(rules("src/x.ts", "// generated with an AI model")).toContain("attribution");
    expect(rules("README.md", "Co-Authored-By: Someone <a@b.c>")).toContain("attribution");
  });
});

describe("production content — must STAY SILENT on legitimate product material", () => {
  it("ignores ordinary issue and milestone references", () => {
    expect(rules("src/lib/tts.ts", "// RAWY-257 (C1): the retry ladder")).toEqual([]);
    expect(rules("src-tauri/src/books/compat.rs", "//! RESILIENCE-1 / WP-2 — the compatibility layer.")).toEqual([]);
    expect(rules("src/x.ts", "// AUD-12: enables the search fold")).toEqual([]);
  });

  it("ignores standard Windows system locations a product may name", () => {
    expect(rules("src-tauri/src/commands/mod.rs", String.raw`r"C:\Windows\System32\drivers\etc\hosts"`)).toEqual([]);
    expect(rules("src-tauri/src/commands/mod.rs", String.raw`r"C:\Users\Public\important.png"`)).toEqual([]);
  });

  it("ignores environment-variable paths", () => {
    expect(rules("BUILD.md", String.raw`add %USERPROFILE%\.cargo\bin to PATH`)).toEqual([]);
    expect(rules("src/lib/x.ts", String.raw`%APPDATA%\com.sard.app\sard.db`)).toEqual([]);
  });

  it("ignores ordinary product prose and the public repository URL", () => {
    expect(rules("README.md", "git clone https://github.com/Limitless-Soul1/Sard.git")).toEqual([]);
    expect(rules("src/lib/updater.ts", "// verifies the minisign signature against the compiled-in public key")).toEqual([]);
  });

  it("does not treat a placeholder as a secret", () => {
    expect(rules("BUILD.md", `$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<its password>"`)).toEqual([]);
  });

  it("never scans vendored third-party code", () => {
    expect(isVendored("public/foliate-js/vendor/pdfjs/pdf.mjs")).toBe(true);
    expect(isVendored("src-tauri/resources/piper/espeak-ng-data/x")).toBe(true);
    expect(isVendored("src/lib/tts.ts")).toBe(false);
    // Upstream wording that WOULD match several rules, left alone because of where it lives.
    expect(rules("public/foliate-js/vendor/pdfjs/pdf.mjs", 'throw new Error("No response from the AI service.");')).toEqual([]);
    expect(rules("public/foliate-js/tests/tests.js", "// see tests/harness/x.mjs and M:/nope")).toEqual([]);
  });

  it("honours per-rule exemptions without excusing the file entirely", () => {
    // The rules file must name what it excludes; that is the rule itself.
    expect(rules("scripts/production-tree-rules.mjs", "/^scripts\\/(pack-diag|build-test)\\.mjs$/")).toEqual([]);
    // But it is still scanned for everything else.
    expect(rules("scripts/production-tree-rules.mjs", `const p = "M:\\\\ProjectDocs";`)).toContain("private-path");
  });

  it("skips binary assets", () => {
    expect(rules("docs/screenshots/Library.png", "M:\\ProjectDocs pack-diag")).toEqual([]);
  });
});

describe("production package.json", () => {
  const allowed = ["dev", "build", "preview", "tauri", "verify:release"];
  const tree = new Set(["package.json", "scripts/verify-artifact.mjs"]);

  it("accepts a manifest carrying only allowlisted scripts", () => {
    const pkg = JSON.stringify({ scripts: { build: "tsc && vite build", tauri: "tauri" } });
    expect(scanPackageJson(pkg, allowed, tree)).toEqual([]);
  });

  it("rejects a development script", () => {
    const pkg = JSON.stringify({ scripts: { build: "tsc", "harness:csp": "node tests/harness/csp.mjs" } });
    const out = scanPackageJson(pkg, allowed, tree) as Violation[];
    expect(out.map((v) => v.rule)).toContain("package-script");
    expect(out[0].why).toMatch(/harness:csp/);
  });

  it("rejects an allowlisted script pointing at a file the tree does not contain", () => {
    const pkg = JSON.stringify({ scripts: { "verify:release": "node scripts/gone.mjs" } });
    const out = scanPackageJson(pkg, allowed, tree) as Violation[];
    expect(out).toHaveLength(1);
    expect(out[0].why).toMatch(/not in the published tree/);
  });

  it("reports unparseable JSON rather than passing it", () => {
    expect((scanPackageJson("{ nope", allowed, tree) as Violation[])[0].rule).toBe("package-json");
  });
});
