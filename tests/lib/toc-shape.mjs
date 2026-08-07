// RESILIENCE-1 — TOC shape analysis.
//
// Answers one question the Alice navigation bug turns on: how many TOC entries point INTO THE SAME
// spine section? A section holding several entries (a title page, an edition line and a contents
// heading, all in one front-matter document) is the shape where "which entry am I on?" stops having
// an obvious answer — and where Sard's fallback picked the wrong one.
//
// Independent of Sard's parser and of foliate's, like the rest of tests/lib.

import { readFileSync } from "node:fs";
import { zipEntries, zipRead, decodeXml } from "./epub-read.mjs";

const attr = (tag, name) => tag.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? null;

const resolve = (base, href) =>
  (base + href)
    .split("/")
    .reduce((acc, seg) => (seg === "" || seg === "." ? acc : seg === ".." ? acc.slice(0, -1) : [...acc, seg]), [])
    .join("/");

/**
 * → `{ entries: [{label, href, path, fragment}], spineOrder: [path], bySection: Map<path, count> }`
 * `entries` is in TOC order; `spineOrder` is the linear spine, so a caller can map either way.
 */
export function tocShape(pathOrBuf) {
  const buf = Buffer.isBuffer(pathOrBuf) ? pathOrBuf : readFileSync(pathOrBuf);
  const es = zipEntries(buf);
  const out = { entries: [], spineOrder: [], bySection: new Map() };
  if (!es) return out;
  const map = new Map(es.map((e) => [e.name, e]));

  const container = decodeXml(zipRead(buf, map.get("META-INF/container.xml")));
  const opfPath = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!opfPath || !map.has(opfPath)) return out;
  const opf = decodeXml(zipRead(buf, map.get(opfPath)));
  if (!opf) return out;
  const base = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";

  const items = [...opf.matchAll(/<item\b[^>]*>/gi)].map((m) => m[0]);
  const byId = new Map(items.map((el) => [attr(el, "id"), el]));

  out.spineOrder = [...opf.matchAll(/<itemref\b[^>]*>/gi)]
    .map((m) => byId.get(attr(m[0], "idref")))
    .filter(Boolean)
    .map((el) => resolve(base, attr(el, "href") ?? ""));

  const navHref = items.find((el) => (attr(el, "properties") ?? "").split(/\s+/).includes("nav"));
  const ncxHref = items.find((el) => attr(el, "media-type") === "application/x-dtbncx+xml");

  const readDoc = (el) => {
    const href = el && attr(el, "href");
    if (!href) return null;
    const entry = map.get(resolve(base, href));
    return entry ? { text: decodeXml(zipRead(buf, entry)), base: resolve(base, href) } : null;
  };

  // nav document first, then NCX — the order foliate itself uses (epub.js:1001-1016).
  const nav = readDoc(navHref);
  let hrefs = [];
  let docBase = "";
  if (nav?.text) {
    const tocNav = nav.text.match(/<nav\b[^>]*epub:type\s*=\s*["'][^"']*\btoc\b[^"']*["'][\s\S]*?<\/nav>/i)?.[0];
    if (tocNav) {
      hrefs = [...tocNav.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
        href: m[1],
        label: m[2].replace(/<[^>]*>/g, "").trim(),
      }));
      docBase = nav.base;
    }
  }
  if (!hrefs.length) {
    const ncx = readDoc(ncxHref);
    if (ncx?.text) {
      hrefs = [...ncx.text.matchAll(/<navPoint\b[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content[^>]*src\s*=\s*["']([^"']+)["']/gi)].map(
        (m) => ({ href: m[2], label: m[1].trim() }),
      );
      docBase = ncx.base;
    }
  }

  const docDir = docBase.includes("/") ? docBase.slice(0, docBase.lastIndexOf("/") + 1) : "";
  for (const { href, label } of hrefs) {
    const [rawPath, fragment = null] = href.split("#");
    const path = resolve(docDir, rawPath);
    out.entries.push({ label, href, path, fragment });
    out.bySection.set(path, (out.bySection.get(path) ?? 0) + 1);
  }
  return out;
}

/** Sections holding more than one TOC entry → `[{path, count, entries}]`, worst first. */
export function multiEntrySections(shape) {
  return [...shape.bySection.entries()]
    .filter(([, n]) => n > 1)
    .map(([path, count]) => ({ path, count, entries: shape.entries.filter((e) => e.path === path) }))
    .sort((a, b) => b.count - a.count);
}
