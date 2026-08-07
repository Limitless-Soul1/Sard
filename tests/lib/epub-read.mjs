// WP-0 (RESILIENCE-1) — one EPUB reader, shared by the fixture self-test and the corpus manifest.
//
// ONE reader on purpose. The fixture test asks "does this file have the defect it claims?" and the
// corpus manifest asks "does this real book still have the traits it had at admission?" — if those
// used two readers they could disagree, and a disagreement would look like a product regression.
//
// This deliberately does NOT reuse Sard's Rust parser or foliate's. It is an INDEPENDENT observer:
// its job is to describe what is in the file, so that a change in how Sard reads a file shows up as
// a difference rather than being reproduced by the measuring instrument.

import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

/** Locate and parse the zip central directory. Returns null when this is not a readable zip. */
export function zipEntries(buf) {
  let eo = -1;
  const floor = Math.max(0, buf.length - 66_000);
  for (let i = buf.length - 22; i >= floor; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eo = i;
      break;
    }
  }
  if (eo < 0) return null; // no end-of-central-directory → truncated or not a zip
  const count = buf.readUInt16LE(eo + 10);
  let off = buf.readUInt32LE(eo + 16);
  if (off === 0xffffffff) return null; // zip64 — out of scope for the corpus
  const out = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    out.push({
      name: buf.subarray(off + 46, off + 46 + nameLen).toString("utf8"),
      method: buf.readUInt16LE(off + 10),
      csize: buf.readUInt32LE(off + 20),
      usize: buf.readUInt32LE(off + 24),
      lho: buf.readUInt32LE(off + 42),
    });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

/** Raw bytes of one entry, or null when it cannot be read. */
export function zipRead(buf, entry) {
  const lh = entry.lho;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) return null;
  const nl = buf.readUInt16LE(lh + 26);
  const el = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nl + el;
  const raw = buf.subarray(start, start + entry.csize);
  if (raw.length < entry.csize) return null; // truncated payload
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) {
    try {
      return inflateRawSync(raw);
    } catch {
      return null;
    }
  }
  return null;
}

/** Decode by BOM, then by the XML declaration, then UTF-8. Mirrors what WP-2A will do in Rust. */
export function decodeXml(bytes) {
  if (!bytes) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return null; // UTF-16BE — not produced by the fixtures
  const head = bytes.subarray(0, 200).toString("latin1");
  const declared = head.match(/encoding\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
  const body = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? bytes.subarray(3) : bytes;
  if (declared === "windows-1256" || declared === "cp1256") {
    try {
      return new TextDecoder("windows-1256").decode(body);
    } catch {
      /* fall through */
    }
  }
  return body.toString("utf8");
}

const tag = (xml, name) =>
  xml?.match(new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i"))?.[1]?.trim() ?? null;

/**
 * Describe an EPUB's structure. Every field is an OBSERVATION, never a judgement — the caller
 * decides what counts as a defect. `readable: false` means the bytes are not a usable zip.
 */
export function describeEpub(pathOrBuf) {
  const buf = Buffer.isBuffer(pathOrBuf) ? pathOrBuf : readFileSync(pathOrBuf);
  const d = {
    bytes: buf.length,
    readable: false,
    mimetype: null,
    mimetypeStored: null,
    mimetypeBom: false,
    opfPath: null,
    opfEncoding: null,
    epubVersion: null,
    hasMetadataBlock: null,
    title: null,
    creator: null,
    language: null,
    ppd: null,
    producer: null,
    spineCount: 0,
    manifestCount: 0,
    tocEntries: 0,
    tocSource: "none",
    cssFiles: 0,
    arabicRatio: 0,
  };
  const es = zipEntries(buf);
  if (!es || es.length === 0) return d;
  d.readable = true;
  const map = new Map(es.map((e) => [e.name, e]));

  const mt = map.get("mimetype");
  if (mt) {
    const raw = zipRead(buf, mt);
    d.mimetypeStored = mt.method === 0;
    if (raw) {
      d.mimetypeBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
      d.mimetype = decodeXml(raw)?.trim() ?? null;
    }
  }

  const container = map.get("META-INF/container.xml");
  const cx = container ? decodeXml(zipRead(buf, container)) : null;
  d.opfPath = cx?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;

  // Resolved from the OPF manifest below, not guessed from filenames — see the note at the TOC block.
  let navHref = null;
  let ncxHref = null;
  const opfDir = d.opfPath?.includes("/") ? d.opfPath.slice(0, d.opfPath.lastIndexOf("/") + 1) : "";

  if (d.opfPath && map.has(d.opfPath)) {
    const opfBytes = zipRead(buf, map.get(d.opfPath));
    const opf = decodeXml(opfBytes);
    if (opf) {
      d.opfEncoding = opf.match(/encoding\s*=\s*["']([^"']+)["']/i)?.[1] ?? "(none)";
      d.epubVersion = opf.match(/<package[^>]*\bversion\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
      d.hasMetadataBlock = /<(?:\w+:)?metadata[\s>]/i.test(opf);
      d.title = tag(opf, "title");
      d.creator = tag(opf, "creator");
      d.language = tag(opf, "language");
      d.ppd = opf.match(/page-progression-direction\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
      d.producer = opf.match(/role\s*=\s*["']bkp["'][^>]*>([^<]+)</i)?.[1]?.trim() ?? null;
      d.spineCount = (opf.match(/<itemref\b/gi) ?? []).length;
      d.manifestCount = (opf.match(/<item\b/gi) ?? []).length;

      // Resolve the nav document and the NCX the way the FORMAT defines them, not by filename.
      // Guessing at `nav.xhtml` / `*.ncx` mis-read two real books in the corpus (Alice and
      // The Count of Monte Cristo both name their nav document something else) and would have
      // written "no TOC" into the manifest as a permanent, wrong assertion.
      const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => m[0]);
      const attr = (el, a) => el.match(new RegExp(`\\b${a}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? null;
      for (const el of items) {
        const props = attr(el, "properties") ?? "";
        if (props.split(/\s+/).includes("nav")) navHref = attr(el, "href");
      }
      const ncxId = opf.match(/<spine\b[^>]*\btoc\s*=\s*["']([^"']+)["']/i)?.[1] ?? null;
      for (const el of items) {
        const id = attr(el, "id");
        const media = attr(el, "media-type") ?? "";
        if ((ncxId && id === ncxId) || media === "application/x-dtbncx+xml") ncxHref = attr(el, "href");
      }
    }
  }

  // TOC: nav document first, then NCX — the same order foliate uses (epub.js:1001-1016), so a
  // "degenerate TOC" here means the same thing it will mean in the product.
  const resolve = (href) => {
    if (!href) return null;
    const joined = (opfDir + href).split("/").reduce((acc, seg) => {
      if (seg === "" || seg === ".") return acc;
      if (seg === "..") return acc.slice(0, -1);
      return [...acc, seg];
    }, []);
    return map.get(joined.join("/")) ?? null;
  };

  const navEntry = resolve(navHref);
  const navDoc = navEntry ? decodeXml(zipRead(buf, navEntry)) : null;
  // The toc nav is the <nav epub:type="toc">; a document may also carry page-list/landmarks navs,
  // whose <li>s must not be counted as chapters.
  const tocNav = navDoc?.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][\s\S]*?<\/nav>/i)?.[0] ?? null;
  if (tocNav) {
    d.tocEntries = (tocNav.match(/<li[\s>]/gi) ?? []).length;
    d.tocSource = "nav";
  } else {
    const ncxEntry = resolve(ncxHref) ?? es.find((e) => e.name.toLowerCase().endsWith(".ncx")) ?? null;
    const ncx = ncxEntry ? decodeXml(zipRead(buf, ncxEntry)) : null;
    if (ncx) {
      d.tocEntries = (ncx.match(/<navPoint\b/gi) ?? []).length;
      d.tocSource = "ncx";
    }
  }

  d.cssFiles = es.filter((e) => e.name.toLowerCase().endsWith(".css")).length;

  // Arabic-letter ratio over a bounded sample of the content documents — the independent check on
  // whatever RAWY-189's Rust sniff concludes.
  const docs = es.filter((e) => /\.x?html?$/i.test(e.name) && !/nav\.x?html$/i.test(e.name)).slice(0, 8);
  let ar = 0;
  let lat = 0;
  for (const e of docs) {
    const text = (decodeXml(zipRead(buf, e)) ?? "").replace(/<[^>]*>/g, "").slice(0, 20_000);
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if ((cp >= 0x0620 && cp <= 0x064a) || (cp >= 0x0671 && cp <= 0x06d3)) ar++;
      else if ((cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122)) lat++;
    }
  }
  d.arabicRatio = ar + lat === 0 ? 0 : Math.round((ar / (ar + lat)) * 100) / 100;
  return d;
}
