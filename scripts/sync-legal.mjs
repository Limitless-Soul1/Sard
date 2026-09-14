// THE LEGAL TEXT SARD SHIPS, TAKEN FROM THE REPOSITORY THAT OWNS IT.
//
// WHY THIS EXISTS. Sard has to show the Terms and the Privacy Policy before a reader accepts them,
// and it has to do that with no network — a first launch may have none, and a legal gate that fails
// open is not a gate. So the text has to live inside the application. The moment it does, there are
// two copies of a legal document in the world, and the failure this script exists to prevent is the
// one nobody notices: the source says version A, the application shows version B, and the reader
// accepted neither.
//
// The answer is not to copy carefully. It is to make the copy DERIVED and CHECKABLE:
//
//   node scripts/sync-legal.mjs              regenerate the snapshot from the source
//   node scripts/sync-legal.mjs --verify     fail if the snapshot and the source disagree
//   node scripts/sync-legal.mjs --selfcheck  fail if the snapshot has been edited by hand
//
// TWO CHECKS, BECAUSE THEY ANSWER TWO DIFFERENT QUESTIONS, and only one of them can run everywhere.
//
// `--verify` is the strong one: it re-derives the whole snapshot from the source and compares. It
// is also the one that needs a checkout of a second repository, so it belongs at the moment a
// release is built, where that checkout exists and where being wrong is expensive.
//
// `--selfcheck` needs nothing but this repository. The snapshot carries a hash of its own content,
// so a file that has been opened and edited — the likeliest drift by far, and the one a reviewer
// would not notice in a diff of thirty-eight thousand characters — fails immediately. That makes it
// safe to run in the ordinary test suite, on every machine, with no external dependency. A gate
// that can only run in one place is a gate that usually does not run.
//
// THE SOURCE IS THE `sard-legal` REPOSITORY, which is independent of this one and is not a build
// dependency — the snapshot is committed, so an ordinary build never needs it. Point at a checkout
// with SARD_LEGAL_SRC, or keep one beside this repository as ../sard-legal.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = process.env.SARD_LEGAL_SRC
  ? resolve(process.env.SARD_LEGAL_SRC)
  : resolve(ROOT, "..", "sard-legal");
const OUT = join(ROOT, "src", "legal", "content.generated.ts");
const VERIFY = process.argv.includes("--verify");
const SELFCHECK = process.argv.includes("--selfcheck");

const die = (msg) => {
  console.error("\n[legal] " + msg + "\n");
  process.exit(1);
};

/** The hash the snapshot carries of its own legal content. Order is fixed, so it is reproducible. */
const hashOf = (rev, terms, privacy) =>
  createHash("sha256").update(JSON.stringify({ rev, terms, privacy })).digest("hex").slice(0, 32);

// ── the cheap check, first, because it needs nothing ─────────────────────────────────────────────
if (SELFCHECK) {
  if (!existsSync(OUT)) die(`no vendored legal snapshot at ${OUT} — run  node scripts/sync-legal.mjs`);
  const src = readFileSync(OUT, "utf8");
  const grab = (name) => {
    const m = src.match(new RegExp(`export const ${name} = ("[^"]*");`));
    return m ? JSON.parse(m[1]) : null;
  };
  const rev = grab("LEGAL_REVISION");
  const stated = grab("LEGAL_CONTENT_HASH");
  const docOf = (name) => {
    const m = src.match(new RegExp(`export const ${name}: LegalDocument = ([\\s\\S]*?);\\n`));
    if (!m) die(`${OUT}: ${name} is missing or malformed`);
    return JSON.parse(m[1]);
  };
  const t = docOf("LEGAL_TERMS");
  const pv = docOf("LEGAL_PRIVACY");
  if (!rev || !stated) die(`${OUT} carries no revision or no content hash — regenerate it`);
  const actual = hashOf(rev, t, pv);
  if (actual !== stated) {
    die("THE VENDORED LEGAL TEXT HAS BEEN EDITED BY HAND.\n"
      + `  snapshot: ${OUT}\n`
      + `  it declares ${stated} and its content hashes to ${actual}.\n`
      + "  This file is generated. Change the sard-legal repository and re-run  node scripts/sync-legal.mjs .");
  }
  const derived = `terms-${t.version}+privacy-${pv.version}`;
  if (rev !== derived) die(`${OUT}: revision "${rev}" does not derive from its documents ("${derived}")`);
  console.log(`[legal] snapshot is intact — ${rev} ${actual}`);
  process.exit(0);
}

if (!SELFCHECK && !existsSync(join(SRC, "revision.json"))) {
  die(`no legal source at ${SRC}\n`
    + "  Point at a checkout of the sard-legal repository:\n"
    + "    SARD_LEGAL_SRC=/path/to/sard-legal node scripts/sync-legal.mjs"
    + (VERIFY ? "\n  (--verify cannot run without the source; the committed snapshot is unchanged.)" : ""));
}

const read = (f) => readFileSync(join(SRC, f), "utf8");
const revision = JSON.parse(read("revision.json"));

/** Text of one element: tags out, entities in, whitespace collapsed. Wording is never altered. */
const textOf = (html) =>
  html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The blocks of one language's article, in document order.
 *
 * The documents are hand-written HTML with a small, stable vocabulary — an eyebrow, a title, a
 * lede, the version stamp, a summary note, numbered headings, paragraphs and list items. Each block
 * keeps WHAT IT IS as well as what it says, so Sard can set a heading as a heading without guessing
 * from the text, and without ever injecting the source's markup into the application.
 */
function blocks(article) {
  const out = [];
  const re = /<(h1|h2|p|li|span|div)\b([^>]*)>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(article))) {
    const [, tag, attrs, inner] = m;
    const cls = (attrs.match(/class="([^"]*)"/) || [, ""])[1];
    let kind = null;
    if (tag === "h1") kind = "h1";
    else if (tag === "h2") kind = "h2";
    else if (tag === "li") kind = "li";
    else if (tag === "span" && /\beyebrow\b/.test(cls)) kind = "eyebrow";
    else if (tag === "div" && /\bstamp\b/.test(cls)) kind = "stamp";
    else if (tag === "div" && /\bnote\b/.test(cls)) kind = "note";
    else if (tag === "p") kind = /\blede\b/.test(cls) ? "lede" : "p";
    if (!kind) continue;
    // A stamp is two spans; a note wraps its own paragraphs, which the scan would otherwise emit
    // twice — once inside the note and once on their own.
    if (kind === "stamp") {
      const parts = [...inner.matchAll(/<span>([\s\S]*?)<\/span>/g)].map((s) => textOf(s[1]));
      out.push({ k: "stamp", t: parts.join(" · ") });
      continue;
    }
    if (kind === "note") {
      out.push({ k: "note", t: textOf(inner) });
      re.lastIndex = m.index + m[0].length;
      continue;
    }
    const t = textOf(inner);
    if (t) out.push({ k: kind, t });
  }
  // A note's paragraphs are captured by the note itself; drop the duplicates the flat scan makes.
  const seenInNotes = new Set(out.filter((b) => b.k === "note").map((b) => b.t));
  return out.filter((b) => !(b.k === "p" && [...seenInNotes].some((n) => n.includes(b.t))));
}

/** Both language articles of one document, plus the version it declares about itself. */
function document(file, expected) {
  const html = read(file);
  const meta = (html.match(/name="sard-legal-version"\s+content="([^"]+)"/) || [])[1];
  if (!meta) die(`${file} carries no sard-legal-version marker`);
  if (meta !== expected) {
    die(`${file} says version ${meta}, revision.json says ${expected} — the source disagrees with itself`);
  }
  const stamps = [...html.matchAll(/<span>(?:Version|الإصدار)\s*([0-9.]+)<\/span>/g)].map((s) => s[1]);
  if (stamps.length !== 2 || stamps.some((v) => v !== expected)) {
    die(`${file}: the visible stamps say ${JSON.stringify(stamps)} but the marker says ${expected}`
      + " — a reader and a program would be told different things");
  }
  const grab = (lang) => {
    const m = html.match(new RegExp(`<article class="doc lang-${lang}"[^>]*>([\\s\\S]*?)</article>`));
    if (!m) die(`${file} has no ${lang} article`);
    const b = blocks(m[1]);
    if (b.length < 8) die(`${file} ${lang}: only ${b.length} blocks — the source shape has changed`);
    return b;
  };
  return { version: expected, en: grab("en"), ar: grab("ar") };
}

const terms = document(revision.documents.terms.path, revision.documents.terms.version);
const privacy = document(revision.documents.privacy.path, revision.documents.privacy.version);

// The combined identifier must be derivable from its parts, or it is just a string someone typed.
const derived = `terms-${terms.version}+privacy-${privacy.version}`;
if (revision.revision !== derived) {
  die(`revision.json says "${revision.revision}" but its own documents derive "${derived}"`);
}

const body = `// GENERATED — DO NOT EDIT.
//
// The approved legal text, taken from the sard-legal repository, which is authoritative. Every word
// here is that repository's; nothing in Sard may alter it. Regenerate with:
//
//     node scripts/sync-legal.mjs
//
// and prove it still matches with \`--verify\`, which the test gate runs.
//
// Revision: ${revision.revision}
// Effective: ${revision.effective}

/** One piece of a legal document — what it is, and what it says. */
export interface LegalBlock {
  k: "eyebrow" | "h1" | "h2" | "lede" | "stamp" | "note" | "p" | "li";
  t: string;
}

export interface LegalDocument {
  version: string;
  en: LegalBlock[];
  ar: LegalBlock[];
}

/** The exact pair of documents a reader is asked to accept. */
export const LEGAL_REVISION = ${JSON.stringify(revision.revision)};

/** When this pair takes effect, in the source's own words. */
export const LEGAL_EFFECTIVE = ${JSON.stringify(revision.effective)};

/**
 * A fingerprint of the legal content below, so this file can be shown to have been generated
 * rather than edited. Quoted in the application beside the revision, which is what turns "which
 * text did this build carry?" into a question with an answer.
 */
export const LEGAL_CONTENT_HASH = ${JSON.stringify(hashOf(revision.revision, terms, privacy))};

export const LEGAL_TERMS: LegalDocument = ${JSON.stringify(terms, null, 2)};

export const LEGAL_PRIVACY: LegalDocument = ${JSON.stringify(privacy, null, 2)};
`;

if (VERIFY) {
  const have = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (have.replace(/\r\n/g, "\n") !== body.replace(/\r\n/g, "\n")) {
    die("THE VENDORED LEGAL TEXT NO LONGER MATCHES ITS SOURCE.\n"
      + `  source:   ${SRC}\n`
      + `  snapshot: ${OUT}\n`
      + "  Run  node scripts/sync-legal.mjs  and review the change before shipping.\n"
      + "  A release whose legal text disagrees with the published documents must not go out.");
  }
  console.log(`[legal] snapshot matches the source — ${revision.revision}`);
  process.exit(0);
}

writeFileSync(OUT, body, "utf8");
console.log(`[legal] wrote ${OUT}`);
console.log(`[legal] revision ${revision.revision}`
  + `  terms ${terms.en.length}/${terms.ar.length} blocks`
  + `  privacy ${privacy.en.length}/${privacy.ar.length} blocks`);
