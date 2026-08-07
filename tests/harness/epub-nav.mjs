// WHAT NAVIGATION PHYSICALLY EXISTS INSIDE AN EPUB.
//
// This reads the container itself — not through foliate, not through Sard — so the answer cannot be
// contaminated by what our own code decides to do with the file. It reports, separately and without
// mixing them:
//
//   the EPUB 3 NAVIGATION DOCUMENT (nav.xhtml, `properties="nav"`), its toc/landmarks/page-list
//   the EPUB 2 NCX                 (spine @toc → toc.ncx), its navPoints and their nesting
//   the SPINE                      (<itemref> order — the reading order of XHTML documents)
//   the XHTML DOCUMENTS themselves (how many, how big, whether each carries a heading)
//
// Those are four different things and the whole investigation turns on not confusing them.
//
// The zip is parsed here rather than shelled out to a tool, because EPUB entry names are UTF-8 and a
// PowerShell round-trip mangles non-Latin text (an established scar in this project).
import { inflateRawSync } from "node:zlib";
import { readFileSync } from "node:fs";

// --- minimal zip reader (central directory → entries) -------------------------------------------
export function readZip(path) {
  const buf = readFileSync(path);
  // End of central directory: scan backwards for the signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a zip (no end-of-central-directory record)");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, compSize, rawSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const nameLen = buf.readUInt16LE(e.offset + 26);
    const extraLen = buf.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nameLen + extraLen;
    const data = buf.subarray(start, start + e.compSize);
    return e.method === 0 ? data : inflateRawSync(data);
  };
  return { entries, read };
}

// OPF and NCX elements may be NAMESPACE-PREFIXED (`<opf:package>`, `<opf:spine>`, `<ncx:navPoint>`)
// and both forms are valid XML. Matching only the unprefixed form made this harness report spine = 0
// for four real books in the library — a silent measurement failure that bucketed them as if they had
// no spine at all. Every element pattern below allows an optional prefix.
const NS = "(?:[A-Za-z0-9_.-]+:)?";
const tag = (name, flags = "i") => new RegExp(`<${NS}${name}\\b[^>]*>`, flags);
const text = (b) => (b ? b.toString("utf8") : null);
const attr = (tag, name) => new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(tag)?.[1] ?? null;
const resolve = (base, rel) => {
  const parts = base.split("/").slice(0, -1);
  for (const seg of decodeURIComponent(rel.split("#")[0]).split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
};

export function inspectEpub(path) {
  const zip = readZip(path);
  const out = { path, ok: false };

  const container = text(zip.read("META-INF/container.xml"));
  const opfPath = container ? attr(tag("rootfile").exec(container)?.[0] ?? "", "full-path") : null;
  out.opfPath = opfPath;
  if (!opfPath) return out;
  const opf = text(zip.read(opfPath));
  if (!opf) return out;

  // MANIFEST: id → { href, properties, mediaType }
  const manifest = new Map();
  for (const m of opf.matchAll(tag("item", "gi"))) {
    const id = attr(m[0], "id");
    if (id) manifest.set(id, { href: attr(m[0], "href"), props: attr(m[0], "properties") ?? "", type: attr(m[0], "media-type") });
  }

  // SPINE: the reading order. `linear="no"` items are not part of the linear reading order.
  const spineTag = tag("spine").exec(opf)?.[0] ?? "";
  const spine = [];
  const spineBlock = new RegExp(`<${NS}spine\\b[\\s\\S]*?</${NS}spine>`, "i").exec(opf)?.[0] ?? "";
  for (const m of spineBlock.matchAll(tag("itemref", "gi"))) {
    const idref = attr(m[0], "idref");
    spine.push({ idref, linear: (attr(m[0], "linear") ?? "yes").toLowerCase(), href: idref ? manifest.get(idref)?.href ?? null : null });
  }
  out.spine = {
    total: spine.length,
    linear: spine.filter((s) => s.linear !== "no").length,
    // Which documents occupy the first LINEAR positions decides whether a generated "chapter N"
    // label lines up with the book's own chapter N, so the positions are reported, not summarised.
    firstLinear: spine.filter((s) => s.linear !== "no").slice(0, 4).map((s, i) => `${i + 1}: ${s.href}`),
    nonLinear: spine.filter((s) => s.linear === "no").map((s) => s.href),
  };
  out.epubVersion = attr(tag("package").exec(opf)?.[0] ?? "", "version");

  // EPUB 3 NAVIGATION DOCUMENT — the item whose properties contain "nav".
  const navItem = [...manifest.values()].find((i) => /\bnav\b/.test(i.props));
  out.navDoc = { present: !!navItem, href: navItem?.href ?? null, tocLinks: null, listCounts: null };
  if (navItem) {
    const navHtml = text(zip.read(resolve(opfPath, navItem.href)));
    if (navHtml) {
      // Count links per <nav>, and identify the toc nav by epub:type.
      const navs = [...navHtml.matchAll(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi)].map((m) => m[0]);
      out.navDoc.listCounts = navs.map((n) => ({
        type: attr(n, "epub:type") ?? attr(n, "type") ?? "(none)",
        links: [...n.matchAll(/<a\b[^>]*>/gi)].length,
      }));
      const toc = navs.find((n) => /toc/i.test(attr(n, "epub:type") ?? "")) ?? navs[0];
      out.navDoc.tocLinks = toc ? [...toc.matchAll(/<a\b[^>]*>/gi)].length : 0;
      out.navDoc.sampleHrefs = toc
        ? [...toc.matchAll(/<a\b[^>]*>/gi)].slice(0, 5).map((m) => attr(m[0], "href"))
        : [];
    }
  }

  // EPUB 2 NCX — referenced by the spine's `toc` attribute.
  const ncxId = attr(spineTag, "toc");
  const ncxHref = ncxId ? manifest.get(ncxId)?.href : [...manifest.values()].find((i) => /ncx/i.test(i.type ?? ""))?.href;
  out.ncx = { present: !!ncxHref, href: ncxHref ?? null, navPoints: null };
  if (ncxHref) {
    const ncx = text(zip.read(resolve(opfPath, ncxHref)));
    if (ncx) {
      const points = [...ncx.matchAll(tag("navPoint", "gi"))].length;
      out.ncx.navPoints = points;
      out.ncx.sampleLabels = [...ncx.matchAll(new RegExp(`<${NS}navPoint\\b[\\s\\S]*?<${NS}text>([\\s\\S]*?)</${NS}text>`, "gi"))]
        .slice(0, 5).map((m) => m[1].replace(/\s+/g, " ").trim().slice(0, 60));
      out.ncx.sampleTargets = [...ncx.matchAll(tag("content", "gi"))].slice(0, 5).map((m) => attr(m[0], "src"));
    }
  }

  // DOES EACH SOURCE ACTUALLY POINT AT THIS BOOK?
  //
  // Entry COUNT alone cannot tell a good navigation source from a plausible-looking broken one: an
  // NCX with 2963 navPoints that target documents outside the spine would look excellent and navigate
  // nowhere. So every target is resolved against the spine and the misses are counted. This is the
  // check that decides whether a source may be trusted, and it is deliberately independent of which
  // source the spec prefers.
  const spineSet = new Set(spine.filter((s) => s.href).map((s) => resolve(opfPath, s.href)));
  const linearSet = new Set(spine.filter((s) => s.href && s.linear !== "no").map((s) => resolve(opfPath, s.href)));
  const validate = (hrefs, base) => {
    const targets = hrefs.map((h) => (h ? resolve(base, h) : null));
    const hit = targets.filter((t) => t && spineSet.has(t));
    return {
      total: targets.length,
      resolved: hit.length,
      unresolved: targets.length - hit.length,
      distinctSpineDocs: new Set(hit).size,
      coverageOfLinearPct: linearSet.size ? Math.round((new Set(hit.filter((t) => linearSet.has(t))).size / linearSet.size) * 100) : 0,
      sampleMisses: targets.filter((t) => t && !spineSet.has(t)).slice(0, 3),
    };
  };
  if (navItem) {
    const navHtml = text(zip.read(resolve(opfPath, navItem.href)));
    const navs = navHtml ? [...navHtml.matchAll(/<nav\b[^>]*>[\s\S]*?<\/nav>/gi)].map((m) => m[0]) : [];
    const toc = navs.find((n) => /toc/i.test(attr(n, "epub:type") ?? "")) ?? navs[0];
    const hrefs = toc ? [...toc.matchAll(/<a\b[^>]*>/gi)].map((m) => attr(m[0], "href")) : [];
    out.navDoc.validation = validate(hrefs, resolve(opfPath, navItem.href));
  }
  if (out.ncx.present) {
    const ncx = text(zip.read(resolve(opfPath, ncxHref)));
    const srcs = ncx ? [...ncx.matchAll(tag("content", "gi"))].map((m) => attr(m[0], "src")) : [];
    out.ncx.validation = validate(srcs, resolve(opfPath, ncxHref));
  }

  // THE SPINE DOCUMENTS THEMSELVES. Do they carry headings? That is the only thing Sard's generated
  // labels can come from, so it decides whether those labels are recovered or invented.
  let withHeading = 0, withTitle = 0, empty = 0, totalBytes = 0;
  const headings = [];
  const perDoc = [];
  for (const s of spine) {
    if (!s.href) continue;
    const body = text(zip.read(resolve(opfPath, s.href)));
    if (body == null) continue;
    totalBytes += body.length;
    const h = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(body);
    const title = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(body);
    const strip = (x) => x.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    const plain = strip(body.replace(/<head[\s\S]*?<\/head>/i, ""));
    if (h) { withHeading++; if (headings.length < 8) headings.push(strip(h[1]).slice(0, 60)); }
    if (title) withTitle++;
    if (plain.length < 20) empty++;
    perDoc.push({ href: s.href, chars: plain.length, heading: h ? strip(h[1]).slice(0, 40) : null,
                  title: title ? strip(title[1]).slice(0, 40) : null });
  }
  out.documents = {
    count: perDoc.length, withHeading, withTitle, nearlyEmpty: empty,
    totalTextChars: totalBytes, sampleHeadings: headings,
    first5: perDoc.slice(0, 5), last3: perDoc.slice(-3),
  };
  out.ok = true;
  return out;
}

// --- CLI ----------------------------------------------------------------------------------------
if (process.argv[1]?.endsWith("epub-nav.mjs")) {
  const targets = process.argv.slice(2);
  for (const t of targets) {
    let r;
    try {
      r = inspectEpub(t);
    } catch (e) {
      console.log(`\n=== ${t}\n  FAILED to read: ${e.message}`);
      continue;
    }
    console.log(`\n${"=".repeat(78)}\n${t.split(/[\\/]/).pop()}`);
    console.log(`  EPUB version        ${r.epubVersion}`);
    console.log(`  OPF                 ${r.opfPath}`);
    console.log(`  SPINE               ${r.spine.total} itemrefs (${r.spine.linear} linear)`);
    console.log(`  first LINEAR spine  ${JSON.stringify(r.spine.firstLinear)}`);
    console.log(`  non-linear items    ${JSON.stringify(r.spine.nonLinear)}`);
    console.log(`  XHTML DOCUMENTS     ${r.documents.count} read`);
    console.log(`     with an <h1-h6>  ${r.documents.withHeading}`);
    console.log(`     with a <title>   ${r.documents.withTitle}`);
    console.log(`     nearly empty     ${r.documents.nearlyEmpty}`);
    console.log(`  EPUB3 NAV DOCUMENT  ${r.navDoc.present ? r.navDoc.href : "ABSENT"}`);
    if (r.navDoc.present) {
      console.log(`     toc links        ${r.navDoc.tocLinks}`);
      console.log(`     navs             ${JSON.stringify(r.navDoc.listCounts)}`);
      console.log(`     first hrefs      ${JSON.stringify(r.navDoc.sampleHrefs)}`);
    }
    console.log(`  EPUB2 NCX           ${r.ncx.present ? r.ncx.href : "ABSENT"}`);
    if (r.ncx.present) {
      console.log(`     navPoints        ${r.ncx.navPoints}`);
      console.log(`     first labels     ${JSON.stringify(r.ncx.sampleLabels)}`);
      console.log(`     first targets    ${JSON.stringify(r.ncx.sampleTargets)}`);
    }
    console.log(`  sample headings     ${JSON.stringify(r.documents.sampleHeadings)}`);
    console.log(`  first documents     ${JSON.stringify(r.documents.first5, null, 1).slice(0, 600)}`);
  }
}
