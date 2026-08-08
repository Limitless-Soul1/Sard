// WHAT MAY LIVE INSIDE A SHIPPED FILE — the content half of the production boundary.
//
// `production-tree-rules.mjs` decides which FILES ship. This decides what may be INSIDE them, and it
// exists because the path rules cannot see either of the two ways v1.2.2 was contaminated:
//
//   * internal material inside a file that legitimately ships — `package.json` carried the whole
//     internal tooling inventory, and a source comment carried a private machine path;
//   * development files under a path no rule named — Rust test modules under `src-tauri/src/`, while
//     the rule named `src-tauri/tests/`.
//
// Both were published while every gate reported success.
//
// DESIGN CONSTRAINTS, because a noisy gate gets switched off:
//   * Narrow and deterministic. Each rule matches one specific, describable thing.
//   * Every match reports file, line and rule id, so a failure is investigable rather than mysterious.
//   * Ordinary product terminology is NOT matched. `RAWY-1234`, `WP-3`, `RESILIENCE-1` and the like are
//     issue and milestone references in product comments; they are public, they explain real code, and
//     sweeping them would be a large edit with no security value.
//   * Vendored third-party code is exempt by path. Upstream wording is not our contamination, and
//     vendored files are never edited to satisfy a rule of ours.

/**
 * Paths whose CONTENTS are never scanned: third-party code we vendor verbatim, with provenance
 * recorded in `public/foliate-js/VENDOR.txt`. Editing these to satisfy our own rules would be worse
 * than the thing the rules prevent.
 */
export const VENDORED = [
  /^public\/foliate-js\//,
  /^src-tauri\/resources\/piper\//,
];

/** Extensions we never read as text. Keeps the scan fast and avoids nonsense matches in binaries. */
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|svg|ttf|otf|woff2?|onnx|wasm|exe|dll|msi|zip|rar|7z|pdf|epub|mp[34]|wav)$/i;

/**
 * THE RULES.
 *
 * `exempt` lists files where a match is expected and legitimate, each with the reason it is allowed.
 * An exemption is per-RULE, never global: a file excused from the tooling-name rule is still scanned
 * for private paths and secrets.
 */
export const CONTENT_RULES = [
  {
    id: "private-path",
    why: "a private or machine-specific filesystem path",
    // Any drive letter other than C: is machine-specific in practice. C: is allowed only for the
    // standard system locations a product may legitimately name.
    //
    // `[\\/]{1,2}` because source code escapes its backslashes: the literal that shipped in v1.2.2 read
    // `"M:\\ProjectDocs\\sard\\Corpus"` in the file. A single-separator pattern misses every path that
    // appears inside a string, which is where they nearly always appear.
    re: /\b[D-Zd-z]:[\\/]|(?:\bC:[\\/]{1,2}Users[\\/]{1,2}(?!Public\b)[A-Za-z0-9._-]+)/,
    exempt: [],
  },
  {
    id: "private-infrastructure",
    why: "a private repository, documentation vault or internal workspace",
    re: /ProjectDocs|Sard-develop|Sard Desktop|Sard Mobile|internal-lab/,
    exempt: [],
  },
  {
    id: "personal-data",
    why: "a reference to real personal data or a live personal library",
    re: /owner's (?:live )?(?:library|database)|\.db-snapshot/i,
    exempt: [
      // The ignore rule is what PREVENTS real database copies from ever being committed. Removing it
      // to satisfy this scanner would delete a protection in order to quieten the thing warning about
      // it. The pattern is a path, and it names no person and no location.
      { re: /^\.gitignore$/, why: "the ignore rule is the protection against committing real data" },
    ],
  },
  {
    id: "dev-tooling",
    why: "the name of a development-only script, harness or packaging utility",
    re: /pack-diag|pack-beta|pack-share|build-test|kill-sard|copy-release|release-to-main|verify-main-buildable|check-production-content|byte-identity|corpus:verify|ro-storm|autopsy-context|ledger-freshness|ppc\d-|rtl-panel|tts-track/,
    exempt: [
      // The path rules must name the very files they exclude — that IS the rule set, and CI runs it
      // against the published tree, so it has to ship. Exempt from THIS rule only.
      { re: /^scripts\/production-tree-rules\.mjs$/, why: "the exclusion patterns are the rule itself" },
      // Ignore rules are paths by nature. They protect `develop`; the comments were already reworded.
      { re: /^\.gitignore$/, why: "ignore patterns are paths, and they protect the development tree" },
    ],
  },
  {
    id: "internal-docs",
    why: "a reference to an internal engineering or planning document",
    re: /docs\/engineering\/|WORKFLOW\.md|HANDBOOK\.md|PROJECT_HANDOFF|CHECKPOINT-\d|REMEDIATION_PLAN|PROJECT_MASTER_SUMMARY|_INVESTIGATION\.md|_STUDY\.md/,
    exempt: [
      { re: /^scripts\/production-tree-rules\.mjs$/, why: "the exclusion patterns are the rule itself" },
      { re: /^\.github\/workflows\//, why: "CI names the gate it runs" },
    ],
  },
  {
    id: "test-infrastructure",
    why: "a reference to test or harness infrastructure that does not ship",
    re: /tests\/harness\/|tests\/unit\/|tests\/corpus\/|tests\/fixtures\//,
    exempt: [
      { re: /^scripts\/production-tree-rules\.mjs$/, why: "the exclusion patterns are the rule itself" },
      { re: /^\.gitignore$/, why: "ignore patterns are paths, and they protect the development tree" },
    ],
  },
  {
    id: "test-module",
    why: "a Rust test module inside the product source",
    re: /^$/, // path-only rule; see `pathRule`
    pathRule: /^src-tauri\/src\/(?:.*\/)?(?:tests|[A-Za-z0-9_]+_tests)\.rs$/,
    exempt: [],
  },
  {
    id: "secret",
    why: "something shaped like a credential, key or token",
    re: /BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key\s*[:=]\s*["'][^"']{8,}|(?:secret|password)\s*[:=]\s*["'][^"'<{$][^"']{6,}|token\s*[:=]\s*["'][A-Za-z0-9_-]{20,}/i,
    exempt: [],
  },
  {
    id: "attribution",
    why: "an assistant, model, vendor or generation attribution",
    // The "generated by/with" clause is bounded to a few words so it fires on "generated with an AI
    // model" but not on ordinary prose like "generated by CI" or "generated by the build script".
    re: /\banthropic\b|\bchatgpt\b|\bopenai\b|\bcopilot\b|\bclaude\b|co-authored-by|generated (?:by|with) (?:an? )?(?:\w+ ){0,2}(?:ai|model|assistant|llm)\b|ai-(?:generated|assisted)/i,
    exempt: [],
  },
];

/** True when `path` is vendored third-party code and must not be scanned. */
export const isVendored = (path) => VENDORED.some((re) => re.test(path));

/** True when `path` is excused from `rule`. Returns the reason, or null. */
export function exemptionFor(rule, path) {
  return (rule.exempt ?? []).find((e) => e.re.test(path)) ?? null;
}

/**
 * Scan one file's text. Returns `{ rule, why, line, text }` for every violation.
 *
 * Pure: no filesystem, no git, no process state — which is what makes it unit-testable.
 */
export function scanText(path, text) {
  const out = [];
  if (isVendored(path) || BINARY.test(path)) return out;

  for (const rule of CONTENT_RULES) {
    if (exemptionFor(rule, path)) continue;

    if (rule.pathRule) {
      if (rule.pathRule.test(path)) out.push({ rule: rule.id, why: rule.why, line: 0, text: path });
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const re = new RegExp(rule.re.source, rule.re.flags.replace("g", ""));
      if (re.test(lines[i])) out.push({ rule: rule.id, why: rule.why, line: i + 1, text: lines[i].trim().slice(0, 160) });
    }
  }
  return out;
}

/**
 * `package.json` is checked structurally rather than by pattern: every script it publishes must be on
 * the allowlist, and none may point at a path the published tree does not contain. A regex over the
 * text could not express either.
 */
export function scanPackageJson(text, allowedScripts, treeFiles) {
  const out = [];
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch (e) {
    return [{ rule: "package-json", why: `package.json does not parse: ${e.message}`, line: 0, text: "" }];
  }
  for (const [name, cmd] of Object.entries(pkg.scripts ?? {})) {
    if (!allowedScripts.includes(name)) {
      out.push({ rule: "package-script", why: `script "${name}" is not on the production allowlist`, line: 0, text: `${name}: ${cmd}` });
      continue;
    }
    for (const ref of String(cmd).match(/(?:scripts|tests)\/[\w./-]+\.(?:mjs|ts|json)/g) ?? []) {
      if (!treeFiles.has(ref)) {
        out.push({ rule: "package-script", why: `script "${name}" runs "${ref}", which is not in the published tree`, line: 0, text: String(cmd) });
      }
    }
  }
  return out;
}
