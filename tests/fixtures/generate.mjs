#!/usr/bin/env node
// WP-0 (RESILIENCE-1) — the generated fixture set.
//
// WHY GENERATED, NOT CHECKED IN. A fixture must isolate exactly ONE defect, and a hand-built binary
// cannot prove that it does. Here the well-formed control and every defective variant come from the
// SAME builder, differing by one named mutation — so "this fixture tests the BOM and nothing else"
// is a property of the code, not a claim in a comment. It also keeps ~0 bytes of binary in a public
// repository.
//
// These complement, and do not replace, the permanent Regression Corpus of REAL books
// held outside the repository. Fixtures prove a specific defect is HANDLED; the corpus proves nothing else broke.
//
// Output: tests/fixtures/epub/<name>.epub  (git-ignored — rebuild with `npm run fixtures:build`)

import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(HERE, "epub");

// ---------------------------------------------------------------------------
// A minimal ZIP writer (store + deflate). Node has no zip writer, and pulling a
// dependency in to build test fixtures would be a poor trade: this is ~60 lines and it
// gives us the one thing an off-the-shelf writer would hide — byte-level control over the
// `mimetype` entry, which is exactly what two of the fixtures need to corrupt.
// ---------------------------------------------------------------------------

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** @param {{name: string, data: Buffer, store?: boolean}[]} entries */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const store = e.store === true;
    const raw = e.data;
    const body = store ? raw : deflateRawSync(raw);
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0, 6); // flags
    lh.writeUInt16LE(store ? 0 : 8, 8); // method
    lh.writeUInt16LE(0, 10); // time
    lh.writeUInt16LE(0, 12); // date
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // extra
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 8); // flags
    ch.writeUInt16LE(store ? 0 : 8, 10); // method
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30); // extra
    ch.writeUInt16LE(0, 32); // comment
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const localBuf = Buffer.concat(locals);
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(localBuf.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

// ---------------------------------------------------------------------------
// The builder. One shape; every fixture is `base` plus ONE named mutation.
// ---------------------------------------------------------------------------

const AR = "السلام عليكم ورحمة الله وبركاته هذا نص عربي طويل يكفي لتجاوز الحد الأدنى للكشف عن اللغة. ";
const EN = "The quick brown fox jumps over the lazy dog and keeps on running all day long. ";

/** The neutral, correct EPUB 3 every fixture starts from. */
function base() {
  return {
    mimetype: { text: "application/epub+zip", store: true, encoding: "utf8" },
    containerXml:
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0">` +
      `<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>` +
      `</container>`,
    opfPath: "OEBPS/content.opf",
    opfEncoding: "utf8",
    opfDeclaredEncoding: "UTF-8",
    title: "A Well-Formed Book",
    creator: "Test Author",
    language: "en",
    ppd: null, // page-progression-direction
    metadataBlock: true,
    version: "3.0",
    chapters: [
      { id: "c1", href: "c1.xhtml", body: EN.repeat(6) },
      { id: "c2", href: "c2.xhtml", body: EN.repeat(6) },
      { id: "c3", href: "c3.xhtml", body: EN.repeat(6) },
    ],
    /** null = no nav doc; otherwise a list of {href,label,children?} */
    nav: [
      { href: "c1.xhtml", label: "Chapter One" },
      { href: "c2.xhtml", label: "Chapter Two" },
      { href: "c3.xhtml", label: "Chapter Three" },
    ],
    /** null = no NCX; otherwise a list of {href,label} */
    ncx: null,
    css: null, // string → written as OEBPS/style.css and linked from every chapter
    truncate: 0, // bytes to chop off the END of the finished zip
  };
}

function encodeText(text, encoding) {
  if (encoding === "utf8") return Buffer.from(text, "utf8");
  if (encoding === "utf8-bom") return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")]);
  if (encoding === "utf16le") return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
  if (encoding === "cp1256") return cp1256Encode(text);
  throw new Error(`unknown encoding ${encoding}`);
}

// windows-1256 (Arabic). Only the mapping the fixtures need: ASCII passes through, Arabic
// U+0621..U+064A maps into 0xC1..0xEA with the documented gaps, and anything unmappable becomes '?'.
const CP1256_ARABIC = {};
{
  // The contiguous run the standard defines: U+0621..U+063A → 0xC1..0xDA, U+0640..U+064A → 0xDC..0xF2 (with gaps).
  const pairs = [
    [0x0621, 0xc1], [0x0622, 0xc2], [0x0623, 0xc3], [0x0624, 0xc4], [0x0625, 0xc5], [0x0626, 0xc6],
    [0x0627, 0xc7], [0x0628, 0xc8], [0x0629, 0xc9], [0x062a, 0xca], [0x062b, 0xcb], [0x062c, 0xcc],
    [0x062d, 0xcd], [0x062e, 0xce], [0x062f, 0xcf], [0x0630, 0xd0], [0x0631, 0xd1], [0x0632, 0xd2],
    [0x0633, 0xd3], [0x0634, 0xd4], [0x0635, 0xd5], [0x0636, 0xd6], [0x0637, 0xd8], [0x0638, 0xd9],
    [0x0639, 0xda], [0x063a, 0xdb], [0x0640, 0xdc], [0x0641, 0xdd], [0x0642, 0xde], [0x0643, 0xdf],
    [0x0644, 0xe1], [0x0645, 0xe3], [0x0646, 0xe4], [0x0647, 0xe5], [0x0648, 0xe6], [0x0649, 0xec],
    [0x064a, 0xed], [0x060c, 0xa1], [0x061b, 0xba], [0x061f, 0xbf],
  ];
  for (const [u, b] of pairs) CP1256_ARABIC[u] = b;
}

function cp1256Encode(text) {
  const out = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) out.push(cp);
    else if (CP1256_ARABIC[cp] != null) out.push(CP1256_ARABIC[cp]);
    else out.push(0x3f); // '?'
  }
  return Buffer.from(out);
}

// The chapter's XML declaration must name the encoding its BYTES are actually in. A real
// windows-1256 book declares windows-1256 in its content documents too, not just in the OPF —
// getting this wrong produced a fixture whose Arabic body decoded to mojibake, so the RTL-sniff
// fixture proved nothing. Caught by the isolation self-test (arabicRatio 0 where 1 was declared).
function buildChapter(spec, cssHref, declaredEncoding = "utf-8", sheet = {}) {
  const link = cssHref ? `<link rel="stylesheet" type="text/css" href="${cssHref}"/>` : "";
  // PPC-1: the two CSS paths that had NEVER been exercised by a hostile fixture. Every WP-7 test to
  // date used an EXTERNAL stylesheet, so "does the sanitiser also cover an inline <style> block and a
  // style= attribute?" was answered only by reading epub.js — which routes all three through
  // `replaceCSS`, where the Sard hook lives. Reading is not measuring, and a fixture that cannot
  // produce the case can never falsify the claim.
  const sb = spec.styleBlock ?? sheet.styleBlock;
  const sa = spec.styleAttr ?? sheet.styleAttr;
  const styleBlock = sb ? `<style type="text/css">${sb}</style>` : "";
  const styleAttr = sa ? ` style="${sa.replace(/"/g, "&quot;")}"` : "";
  // `inlineOnly`: the body carries NO block-level element — paragraphs are inline <span>s separated
  // by <br>, with one bare text node, exactly as .txt→EPUB converters emit. Every walk that assumes
  // "text lives inside a block container" sees an empty document here.
  const body = spec.inlineOnly
    ? `\n  ${spec.body}\n  <br/>\n` +
      [1, 2, 3].map((n) => `  <span class="s${n}">${spec.body}</span>\n  <br/>\n`).join("")
    : `<h1 class="chap">${spec.id}</h1><p class="para"${styleAttr}>${spec.body}</p>`;
  return (
    `<?xml version="1.0" encoding="${declaredEncoding}"?>` +
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${spec.id}</title>${link}${styleBlock}</head>` +
    `<body>${body}</body></html>`
  );
}

function buildNav(nav) {
  const li = (n) =>
    `<li><a href="${n.href}">${n.label}</a>` +
    (n.children ? `<ol>${n.children.map(li).join("")}</ol>` : "") +
    `</li>`;
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">` +
    `<head><title>Contents</title></head><body>` +
    `<nav epub:type="toc" id="toc"><ol>${nav.map(li).join("")}</ol></nav>` +
    `</body></html>`
  );
}

function buildNcx(ncx, title) {
  const points = ncx
    .map(
      (n, i) =>
        `<navPoint id="np${i}" playOrder="${i + 1}"><navLabel><text>${n.label}</text></navLabel>` +
        `<content src="${n.href}"/></navPoint>`,
    )
    .join("");
  return (
    `<?xml version="1.0" encoding="utf-8"?>` +
    `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">` +
    `<head><meta name="dtb:uid" content="urn:uuid:fixture"/></head>` +
    `<docTitle><text>${title}</text></docTitle>` +
    `<navMap>${points}</navMap></ncx>`
  );
}

function buildOpf(s) {
  const manifest = [
    ...s.chapters.map((c) => `<item id="${c.id}" href="${c.href}" media-type="application/xhtml+xml"/>`),
    s.nav ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>` : "",
    s.ncx ? `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>` : "",
    s.css ? `<item id="css" href="style.css" media-type="text/css"/>` : "",
  ]
    .filter(Boolean)
    .join("");
  const spine = s.chapters.map((c) => `<itemref idref="${c.id}"/>`).join("");
  const metadata = s.metadataBlock
    ? `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      (s.title == null ? "" : `<dc:title>${s.title}</dc:title>`) +
      (s.creator == null ? "" : `<dc:creator>${s.creator}</dc:creator>`) +
      (s.language == null ? "" : `<dc:language>${s.language}</dc:language>`) +
      `<dc:identifier id="pub-id">urn:uuid:fixture</dc:identifier>` +
      (s.producer ? `<dc:contributor opf:role="bkp" xmlns:opf="http://www.idpf.org/2007/opf">${s.producer}</dc:contributor>` : "") +
      `</metadata>`
    : ""; // the "missing <metadata>" defect
  const spineAttrs = [s.ncx ? ` toc="ncx"` : "", s.ppd ? ` page-progression-direction="${s.ppd}"` : ""].join("");
  return (
    `<?xml version="1.0" encoding="${s.opfDeclaredEncoding}"?>` +
    `<package xmlns="http://www.idpf.org/2007/opf" version="${s.version}" unique-identifier="pub-id">` +
    metadata +
    `<manifest>${manifest}</manifest>` +
    `<spine${spineAttrs}>${spine}</spine>` +
    `</package>`
  );
}

/** Assemble one fixture spec into EPUB bytes. */
export function buildEpub(spec) {
  const s = { ...base(), ...spec };
  const dir = s.opfPath.includes("/") ? s.opfPath.slice(0, s.opfPath.lastIndexOf("/") + 1) : "";
  const cssHref = s.css ? "style.css" : null;

  const entries = [
    // The mimetype entry MUST be first and SHOULD be stored uncompressed. Both are mutable here,
    // because both are real-world violations Sard has to survive.
    { name: "mimetype", data: encodeText(s.mimetype.text, s.mimetype.encoding), store: s.mimetype.store },
    { name: "META-INF/container.xml", data: Buffer.from(s.containerXml, "utf8") },
    { name: s.opfPath, data: encodeText(buildOpf(s), s.opfEncoding) },
    ...s.chapters.map((c) => ({
      name: dir + c.href,
      data: encodeText(buildChapter(c, cssHref, s.opfDeclaredEncoding, s), s.opfEncoding),
    })),
  ];
  if (s.nav) entries.push({ name: dir + "nav.xhtml", data: Buffer.from(buildNav(s.nav), "utf8") });
  if (s.ncx) entries.push({ name: dir + "toc.ncx", data: Buffer.from(buildNcx(s.ncx, s.title ?? ""), "utf8") });
  if (s.css) entries.push({ name: dir + "style.css", data: Buffer.from(s.css, "utf8") });

  const zip = makeZip(entries);
  return s.truncate > 0 ? zip.subarray(0, zip.length - s.truncate) : zip;
}

// ---------------------------------------------------------------------------
// The fixtures. Each entry: ONE mutation from `base()`, and a `proves` line naming the
// defect it isolates and the work package that consumes it.
// ---------------------------------------------------------------------------

const arChapters = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `c${i + 1}`, href: `c${i + 1}.xhtml`, body: AR.repeat(8) }));

export const FIXTURES = {
  "control-wellformed": {
    proves: "the golden control — every other fixture differs from this by exactly one mutation",
    spec: {},
  },

  "bom-mimetype": {
    proves: "WP-2A · a UTF-8 BOM on the mimetype entry must not reject the book (rejected today)",
    spec: { mimetype: { text: "application/epub+zip", store: true, encoding: "utf8-bom" } },
  },

  "compressed-mimetype": {
    proves: "WP-2A · a DEFLATE'd mimetype entry (spec violation, seen in the real corpus) still imports",
    spec: { mimetype: { text: "application/epub+zip", store: false, encoding: "utf8" } },
  },

  "trailing-newline-mimetype": {
    proves: "WP-2A · a trailing newline is tolerated today and must STAY tolerated (backward compatibility)",
    spec: { mimetype: { text: "application/epub+zip\n", store: true, encoding: "utf8" } },
  },

  "no-metadata-block": {
    proves: "WP-1A/WP-2 · an OPF with no <metadata> must give a `compat` error, not a raw TypeError (epub.js:178)",
    spec: { metadataBlock: false },
  },

  "cp1256-opf": {
    proves: "WP-2A · a windows-1256 OPF must yield title/author/language AND still sniff RTL (loses everything today)",
    spec: {
      opfEncoding: "cp1256",
      opfDeclaredEncoding: "windows-1256",
      title: "كتاب عربي",
      creator: "مؤلف عربي",
      language: "ar",
      chapters: arChapters(6),
      nav: null,
    },
  },

  "utf16-opf": {
    proves: "WP-2A · a UTF-16LE OPF must not fail the UTF-8-only read_to_string path",
    spec: { opfEncoding: "utf16le", opfDeclaredEncoding: "UTF-16", nav: null },
  },

  "placeholder-title": {
    proves: "WP-2C · Calibre's literal 'Unknown'/'word' placeholders must not be shown as real metadata",
    spec: {
      title: "Unknown",
      creator: "word",
      producer: "calibre (9.9.0) [https://calibre-ebook.com]",
    },
  },

  "ncx-single-entry": {
    proves: "WP-2E/WP-6A · a degenerate TOC (1 entry over many sections) must be detected and recovered",
    spec: {
      version: "2.0",
      nav: null,
      ncx: [{ href: "c1.xhtml", label: "Start" }],
      chapters: Array.from({ length: 40 }, (_, i) => ({ id: `c${i + 1}`, href: `c${i + 1}.xhtml`, body: EN.repeat(4) })),
    },
  },

  "no-toc-at-all": {
    proves: "WP-6A · neither a nav doc nor an NCX — foliate's chain ends with nothing (epub.js:1001-1016)",
    spec: { nav: null, ncx: null },
  },

  "nested-toc": {
    proves: "WP-6A · a GOOD nested TOC must be preserved untouched, nesting included",
    spec: {
      nav: [
        { href: "c1.xhtml", label: "Part One", children: [{ href: "c2.xhtml", label: "Chapter Two" }] },
        { href: "c3.xhtml", label: "Part Two" },
      ],
    },
  },

  "fragmented-spine": {
    proves: "WP-2E/WP-6B · Calibre-style split: many tiny sections (the reported book: 115 @ ~2.4 KB median)",
    spec: {
      version: "2.0",
      nav: null,
      ncx: [{ href: "c1.xhtml", label: "Start" }],
      chapters: Array.from({ length: 80 }, (_, i) => ({ id: `c${i + 1}`, href: `c${i + 1}.xhtml`, body: EN })),
    },
  },

  "arabic-tagged-en": {
    proves: "WP-2D · Arabic content declaring dc:language=en with no ppd — the RAWY-189 sniff must flip dir",
    spec: { language: "en", title: "مكتوب بالعربية", chapters: arChapters(8), nav: null },
  },

  "hostile-css": {
    proves:
      "WP-7A · Word-derived absolute + NEGATIVE margins. Enabling book CSS without the sanitiser CLIPS this text.",
    spec: {
      css:
        `.para { margin: 0 369pt 0 -84.8pt; line-height: 1.2; text-align: left; font-size: 9pt; }\n` +
        `.chap { position: absolute; float: left; width: 900px; }\n` +
        `body { color: #000; background: #fff; }\n` +
        `@page { margin-bottom: 5pt; }\n`,
    },
  },

  // PPC-1. Every hostile CSS fixture before this one used an EXTERNAL stylesheet, so the sanitiser's
  // coverage of the other two paths was code-derived only: epub.js routes `<style>` text and `style=`
  // attributes through the same `replaceCSS`, so it *should* apply — never observed at runtime.
  //
  // Each hostile declaration is paired with a benign one the sanitiser must KEEP, so a run where
  // everything disappears (the sheet failed to load, the selector matched nothing, the fixture is
  // broken) is distinguishable from a run where the sanitiser did its job. Without that pairing a
  // vacuous pass looks exactly like a real one — the FINDING-6 lesson.
  "hostile-inline-style": {
    proves:
      "PPC-1 · an inline <style> BLOCK and a style= ATTRIBUTE must be sanitised like an external sheet",
    spec: {
      styleBlock:
        // must be DROPPED
        `.para { margin: -80pt 0 0 -60pt; font-size: 9pt; }\n` +
        `.chap { position: absolute; }\n` +
        `body { color: #010101; }\n` +
        `.para { text-align: left !important; }\n` +
        `.chap { letter-spacing: ! important 4px; }\n` +   // FINDING-1: space between ! and important
        `@media screen { .para { margin: -99pt; } }\n` +
        // must be KEPT — the control that makes a vacuous pass detectable
        `.para { font-style: italic; }\n` +
        `.chap { font-weight: 700; }\n`,
      // The attribute path. `color` on an element (not body/html) is legitimate and must survive;
      // the absolute negative margin must not.
      styleAttr: "color: #c05000; margin-left: -70pt; font-size: 8pt",
    },
  },

  "benign-css": {
    proves: "WP-7A · the control for hostile-css: relative units and emphasis that the sanitiser must KEEP",
    spec: {
      css:
        `.para { margin: 0 0 1em 0; font-size: 95%; font-style: italic; text-align: center; }\n` +
        `.chap { font-weight: 700; text-transform: uppercase; }\n`,
    },
  },

  "truncated-zip": {
    proves: "WP-1A · a damaged archive must give a `corrupt` error naming the file, never a raw exception",
    spec: { truncate: 400 },
  },

  "css-direct-attack": {
    proves:
      "WP-7A · TASK-2 · font-family / color / background declared DIRECTLY on the measured element, " +
      "plus an @font-face that hijacks Sard's own family name. The earlier hostile-css fixture set " +
      "colour on `body` (inheritance only, which any direct rule beats) and declared no font-family " +
      "at all — so the 'redundant' verdict for these three was never actually exercised.",
    spec: {
      css:
        // Direct rules on the SAME element the probe measures — not on an ancestor.
        `.para { color: #ff0000; background-color: #00ff00; font-family: "AttackFont", monospace; }\n` +
        `.chap { color: #ff00ff; font-family: "AttackFont", monospace; }\n` +
        // The hijack: redefine the family NAME Sard's own injected CSS references. If this lands,
        // Sard's font-family rule still "wins" by name while rendering the book's chosen file.
        `@font-face { font-family: "SardArabic"; src: local("Comic Sans MS"); }\n` +
        `@font-face { font-family: "AttackFont"; src: local("Comic Sans MS"); }\n` +
        // Inherited colour too, so both paths are present in one fixture.
        `body { color: #0000ff; background-color: #ffff00; }\n`,
    },
  },

  "no-block-containers": {
    proves:
      "TRACK-1 · a chapter with NO block container (inline <span>s + <br>, the .txt→EPUB shape) must " +
      "still produce speakable units WITH DOM ranges — the reported book spoke 112 units and could " +
      "highlight none of them",
    spec: {
      chapters: [
        { id: "c1", href: "c1.xhtml", body: EN.repeat(6), inlineOnly: true },
        { id: "c2", href: "c2.xhtml", body: EN.repeat(6), inlineOnly: true },
        { id: "c3", href: "c3.xhtml", body: EN.repeat(6), inlineOnly: true },
      ],
    },
  },
};

// ---------------------------------------------------------------------------

export function generateAll(outDir = FIXTURE_DIR) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const built = [];
  for (const [name, { spec, proves }] of Object.entries(FIXTURES)) {
    const bytes = buildEpub(spec);
    writeFileSync(join(outDir, `${name}.epub`), bytes);
    built.push({ name, bytes: bytes.length, proves });
  }
  return built;
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("generate.mjs")) {
  const built = generateAll();
  const pad = Math.max(...built.map((b) => b.name.length));
  for (const b of built) {
    console.log(`  ${b.name.padEnd(pad)}  ${String(b.bytes).padStart(7)} B   ${b.proves}`);
  }
  console.log(`\n${built.length} fixtures → ${FIXTURE_DIR}`);
}
