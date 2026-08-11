// The production boundary against GENERATED MOBILE PLATFORM PROJECTS.
//
// `tauri android init` and `tauri ios init` write a Gradle project and an Xcode project under
// `src-tauri/gen/`. Before this rule existed, neither gate had any opinion about that path:
// `.gitignore` named only `gen/schemas`, and `isDevelopmentOnly()` returns null — meaning SHIP — for
// every path no rule matches. A generated project would therefore have been committed to `develop`
// and published to `main`, carrying local machine paths and the release signing configuration.
//
// WHY THIS TEST EXISTS BEFORE THE GENERATOR DOES. A signing artifact that reaches a public repository
// cannot be withdrawn from it, so the boundary has to be provable before anything can cross it. The
// assertions below are the proof that the rule is present and correctly scoped, and they fail the
// build if either the path rule or the content rule is ever weakened or removed.
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain ESM module, no type declarations
import { isDevelopmentOnly } from "../../scripts/production-tree-rules.mjs";
// @ts-expect-error — plain ESM module, no type declarations
import { scanText } from "../../scripts/production-content-rules.mjs";

type Exclusion = { re: RegExp; why: string } | null;
const excluded = (path: string): Exclusion => isDevelopmentOnly(path) as Exclusion;

type Violation = { rule: string; why: string; line: number; text: string };
const rules = (path: string, text: string): string[] =>
  (scanText(path, text) as Violation[]).map((v) => v.rule);

describe("production tree — generated mobile projects never reach main", () => {
  it("excludes the generated Android project", () => {
    expect(excluded("src-tauri/gen/android/build.gradle")).toBeTruthy();
  });

  it("excludes the generated iOS project", () => {
    expect(excluded("src-tauri/gen/apple/sard.xcodeproj/project.pbxproj")).toBeTruthy();
  });

  it("excludes every depth of the generated tree, not just its top level", () => {
    for (const p of [
      "src-tauri/gen/android/app/src/main/AndroidManifest.xml",
      "src-tauri/gen/android/keystore.properties",
      "src-tauri/gen/apple/ExportOptions.plist",
      "src-tauri/gen/schemas/desktop-schema.json",
    ]) {
      expect(excluded(p), p).toBeTruthy();
    }
  });

  it("states a reason, because an exclusion whose reason is lost is one someone overrides", () => {
    const hit = excluded("src-tauri/gen/android/build.gradle");
    expect(hit?.why).toMatch(/generated mobile platform project/i);
  });

  // The rule must be a boundary, not a blanket. `src-tauri/src/` and `src-tauri/Cargo.toml` are the
  // product and must keep shipping; a rule that swept them out would be caught here rather than by a
  // failed release build.
  it("does not disturb the Rust product tree", () => {
    expect(excluded("src-tauri/src/lib.rs")).toBeNull();
    expect(excluded("src-tauri/src/bookhost.rs")).toBeNull();
    expect(excluded("src-tauri/Cargo.toml")).toBeNull();
    expect(excluded("src-tauri/tauri.conf.json")).toBeNull();
  });
});

describe("production content — signing material never reaches main", () => {
  it("catches a Gradle signing block, which the `secret` rule cannot see", () => {
    // Unquoted, which is why this needed a rule of its own: the `secret` pattern requires a quoted
    // value and would stay silent on every line of this file.
    const src = ["storePassword=example", "keyPassword=example", "keyAlias=upload"].join("\n");
    expect(rules("src-tauri/gen/android/keystore.properties", src)).toContain("signing-material");
  });

  it("catches an Xcode team and provisioning identifier", () => {
    expect(rules("x.pbxproj", "DEVELOPMENT_TEAM = A1B2C3D4E5;")).toContain("signing-material");
    expect(rules("x.pbxproj", 'PROVISIONING_PROFILE_SPECIFIER = "match Development";')).toContain("signing-material");
    expect(rules("x.pbxproj", 'CODE_SIGN_IDENTITY = "Apple Development";')).toContain("signing-material");
  });

  it("catches a reference to a signing artifact by extension", () => {
    for (const line of [
      "storeFile=release.jks",
      "cp cert.p12 /tmp",
      "profile: build.mobileprovision",
    ]) {
      expect(rules("some/shipped/file.ts", line), line).toContain("signing-material");
    }
  });

  it("stays silent on ordinary product source", () => {
    const src = [
      "export const SCHEME = 'sardhost';",
      "// the release build verifies its own identity",
      "const key = settings.get('theme');",
    ].join("\n");
    expect(rules("src/lib/x.ts", src)).not.toContain("signing-material");
  });

  it("exempts .gitignore, which must name the artifacts it refuses", () => {
    expect(rules(".gitignore", "*.jks\n*.p12\n**/keystore.properties")).not.toContain("signing-material");
  });
});
