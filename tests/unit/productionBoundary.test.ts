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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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

// THE `attribution` RULE, AND THE ONE FILE EXCUSED FROM IT.
//
// `AGENTS.md` is addressed to agents, so the sentence naming its audience necessarily contains the
// phrase the rule looks for. It is excused BY PATH, and the mechanism excuses a whole file rather
// than a phrase — which is exactly the risk worth pinning down in a test. Three things are asserted
// here, and the third is the one that matters: the shipped file is checked directly for the
// attributions the rule can no longer catch in it, so the exemption buys the document its audience
// sentence and nothing else.
describe("production content — the attribution rule, and its single exemption", () => {
  // One line per alternative in the rule's pattern. Dropping any alternative — the way an exemption
  // that "wasn't working" might tempt someone to — fails this list rather than passing quietly.
  const FORBIDDEN = [
    "Co-Authored-By: Someone <noreply@example.com>",
    "// generated with an AI assistant",
    "the file was generated by a model",
    "This module was ai-generated from the spec.",
    "an AI-assisted rewrite of the parser",
    "see the Anthropic docs for the endpoint",
    "ported from a ChatGPT answer",
    "an OpenAI schema, adapted",
    "suggested by Copilot and kept",
    "written with Claude alongside",
  ];

  it("accepts the agent rules, whose audience sentence names the thing the rule detects", () => {
    const doc = readFileSync(resolve(import.meta.dirname, "../../AGENTS.md"), "utf8");
    expect(rules("AGENTS.md", doc)).toEqual([]);
  });

  it("still rejects an attribution in any other file", () => {
    for (const path of ["src/lib/x.ts", "README.md", "docs/WORKFLOW.md", "CHANGELOG.md"]) {
      for (const line of FORBIDDEN) {
        expect(rules(path, line), `${path}: ${line}`).toContain("attribution");
      }
    }
  });

  it("does not excuse a path that merely resembles the exempt one", () => {
    // The pattern is anchored at both ends and case-sensitive. Each of these would be excused too if
    // it were not, and each is a plausible file for someone to add.
    for (const path of ["agents.md", "docs/AGENTS.md", "src/AGENTS.md", "MY_AGENTS.md", "AGENTS.md.bak"]) {
      expect(rules(path, FORBIDDEN[0]), path).toContain("attribution");
    }
  });

  it("and the exempt file itself carries no vendor name or co-authorship trailer", () => {
    // The scanner is blind to this file for this one rule, so the file is read here instead. Without
    // this, a vendor name added to AGENTS.md later would ship with nothing objecting.
    const doc = readFileSync(resolve(import.meta.dirname, "../../AGENTS.md"), "utf8");
    for (const term of [/\banthropic\b/i, /\bchatgpt\b/i, /\bopenai\b/i, /\bcopilot\b/i, /\bclaude\b/i, /co-authored-by/i, /ai-generated/i]) {
      expect(doc, String(term)).not.toMatch(term);
    }
  });

  it("is still scanned by every other content rule", () => {
    const doc = readFileSync(resolve(import.meta.dirname, "../../AGENTS.md"), "utf8");
    expect(rules("AGENTS.md", `${doc}\nsee docs/engineering/HANDBOOK.md`)).toContain("internal-docs");
    expect(rules("AGENTS.md", `${doc}\nthe probe lives in tests/harness/cdp.mjs`)).toContain("test-infrastructure");
    expect(rules("AGENTS.md", `${doc}\ncp cert.p12 /tmp`)).toContain("signing-material");
  });
});

// THE PRODUCTION BOUNDARY AGAINST HAND-WRITTEN MOBILE CODE.
//
// The rule beside this one stops GENERATED mobile projects. It stopped nothing a person writes, and
// the gap was measured rather than argued: a source tree carrying `features-mobile/`, a mobile
// stylesheet, a mobile Rust module, a mobile Tauri config and native plugin sources produced a
// 627-file production tree that BOTH gates passed — Gradle and Swift files declared "fit to publish".
//
// Two properties are pinned here, and the second matters as much as the first:
//   1. mobile paths are excluded, so mobile work cannot reach the Windows product; and
//   2. the DESKTOP tree is untouched by that exclusion — the boundary protects the product without
//      changing what it ships.
describe("production tree — hand-written mobile code never reaches the desktop product", () => {
  const MOBILE = [
    "src/features-mobile/app/Shell.tsx",
    "src/features-mobile/reader/Chrome.tsx",
    "src/features-mobile/library/List.tsx",
    "src/styles/mobile.css",
    "src/mobile/gestures.ts",
    "src-tauri/src/mobile/mod.rs",
    "src-tauri/src/mobile/audio.rs",
    "src-tauri/tauri.android.conf.json",
    "src-tauri/tauri.ios.conf.json",
    "plugins/sard-audio/android/build.gradle.kts",
    "plugins/sard-audio/ios/Sources/Plugin.swift",
    "tsconfig.mobile.json",
  ];

  it("excludes every mobile path, with a stated reason", () => {
    for (const path of MOBILE) {
      const why = excluded(path);
      expect(why, `${path} must not reach the production tree`).toBeTruthy();
      expect(why?.why, `${path} must say WHY it is excluded`).toBeTruthy();
    }
  });

  it("still excludes the generated platform projects", () => {
    // The older rule, re-pinned: the new patterns must not have displaced it.
    expect(excluded("src-tauri/gen/android/build.gradle")).toBeTruthy();
    expect(excluded("src-tauri/gen/apple/sard.xcodeproj/project.pbxproj")).toBeTruthy();
  });

  it("does NOT disturb the desktop product", () => {
    // The exclusion must be surgical. These are the neighbours of every pattern above, and each one
    // ships today — if a mobile pattern is ever loosened, this is what notices.
    for (const path of [
      "src/features/reader/Reader.tsx",
      "src/features/library/Library.tsx",
      "src/styles/global.css",
      "src/lib/fonts.ts",
      "src/reader-engine/FoliateController.ts",
      "src/reader-transport/hosted.ts",
      "src-tauri/src/lib.rs",
      "src-tauri/src/books/mod.rs",
      "src-tauri/tauri.conf.json",
      "tsconfig.json",
      "package.json",
    ]) {
      expect(excluded(path), `${path} must still ship to main`).toBeNull();
    }
  });

  it("keeps the mobile capability file, which already ships", () => {
    // Deliberately NOT excluded. It has shipped since 1.3.0 and Tauri reads the capabilities
    // directory at build time, so removing it would change the Windows build to tidy something
    // cosmetic. The boundary exists to protect the desktop line, not to rearrange it.
    expect(excluded("src-tauri/capabilities/mobile.json")).toBeNull();
  });

  it("matches by location, so the exclusion holds as the mobile tree grows", () => {
    for (const path of [
      "src/features-mobile/some/deeply/nested/thing.tsx",
      "src-tauri/src/mobile/deeply/nested.rs",
      "plugins/another-plugin/android/src/main/Whatever.kt",
    ]) {
      expect(excluded(path), `${path} must be excluded by location`).toBeTruthy();
    }
  });

  it("does not catch a desktop path that merely resembles a mobile one", () => {
    // Anchored patterns: a desktop file whose name contains "mobile" is not mobile code.
    for (const path of [
      "src/features/settings/MobileHandoff.tsx",
      "src/lib/mobileDetect.ts",
      "src-tauri/src/mobile_probe.rs",
    ]) {
      expect(excluded(path), `${path} is desktop source and must still ship`).toBeNull();
    }
  });
});
