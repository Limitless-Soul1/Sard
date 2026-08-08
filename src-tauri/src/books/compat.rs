//! RESILIENCE-1 / WP-2 — the EPUB compatibility layer.
//!
//! WHY THIS EXISTS. Imperfect EPUBs are the normal case, not the exception. Measured over the
//! fifteen real books, none of them chosen to prove a point:
//!
//!   * 3 books declare the wrong `dc:language` (Arabic content tagged `en`);
//!   * 11 of 15 declare no `page-progression-direction` at all — RTL is inferred, never stated;
//!   * 1 has a degenerate TOC (116 sections, 1 NCX entry) and literal placeholder metadata
//!     (`<dc:title>Unknown</dc:title>`, `<dc:creator>word</dc:creator>` — Calibre's placeholders);
//!   * 1 violates the specification by DEFLATE-compressing its `mimetype` entry.
//!
//! WHERE IT RUNS, AND WHY HERE. At IMPORT, once per book, not at render. Four reasons:
//!   1. it is once-per-book rather than once-per-section, and the render path is already the
//!      measured bottleneck on a finely-split book;
//!   2. the results are USER-EDITABLE — `metadata_overrides` already exists and already wins via
//!      COALESCE, so a recovered value is a normal correctable value, not magic that reappears;
//!   3. a stored decision can be shown, explained and undone; a render-time heuristic cannot;
//!   4. it matches the existing grain — RAWY-189's script sniff is exactly this pattern and works.
//!
//! EVERYTHING HERE IS PURE. No zip, no database, no filesystem: bytes and strings in, decisions out.
//! That is what makes the rules testable one at a time, which matters because a compatibility layer
//! that damages a GOOD book is worse than none at all.

use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// 2A — tolerant decoding
// ---------------------------------------------------------------------------

/// The encodings this decoder handles, by declared name.
///
/// DELIBERATELY FOUR, and no dependency. The approved fallback chain is UTF-8 → UTF-16 → windows-1256
/// → latin-1, and each of those is exactly tabulatable in a few lines, so pulling in a full encoding
/// library (≈2 MB of tables) to serve four cases would be a poor trade in a project that justifies
/// every dependency it carries. An OPF in a CJK legacy encoding is out of scope: it falls through to
/// latin-1, which still recovers the ASCII structure (spine paths, hrefs, the cover reference) even
/// though its title would be mojibake — strictly better than today, where the whole parse fails and
/// the book loses its metadata, its cover AND its RTL detection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    Utf16Le,
    Utf16Be,
    Windows1256,
    Latin1,
}

/// How the encoding was decided — recorded so a mojibake report can be traced to its cause.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodingSource {
    Bom,
    Declared,
    Utf8Valid,
    Fallback,
}

#[derive(Debug, Clone)]
pub struct Decoded {
    pub text: String,
    pub encoding: Encoding,
    pub source: EncodingSource,
}

/// The windows-1256 (Arabic) high half, 0x80..=0xFF. The low half is ASCII.
/// Transcribed from the Unicode consortium's CP1256.TXT.
#[rustfmt::skip]
const CP1256_HIGH: [char; 128] = [
    '\u{20AC}', '\u{067E}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0679}', '\u{2039}', '\u{0152}', '\u{0686}', '\u{0698}', '\u{0688}',
    '\u{06AF}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{06A9}', '\u{2122}', '\u{0691}', '\u{203A}', '\u{0153}', '\u{200C}', '\u{200D}', '\u{06BA}',
    '\u{00A0}', '\u{060C}', '\u{00A2}', '\u{00A3}', '\u{00A4}', '\u{00A5}', '\u{00A6}', '\u{00A7}',
    '\u{00A8}', '\u{00A9}', '\u{06BE}', '\u{00AB}', '\u{00AC}', '\u{00AD}', '\u{00AE}', '\u{00AF}',
    '\u{00B0}', '\u{00B1}', '\u{00B2}', '\u{00B3}', '\u{00B4}', '\u{00B5}', '\u{00B6}', '\u{00B7}',
    '\u{00B8}', '\u{00B9}', '\u{061B}', '\u{00BB}', '\u{00BC}', '\u{00BD}', '\u{00BE}', '\u{061F}',
    '\u{06C1}', '\u{0621}', '\u{0622}', '\u{0623}', '\u{0624}', '\u{0625}', '\u{0626}', '\u{0627}',
    '\u{0628}', '\u{0629}', '\u{062A}', '\u{062B}', '\u{062C}', '\u{062D}', '\u{062E}', '\u{062F}',
    '\u{0630}', '\u{0631}', '\u{0632}', '\u{0633}', '\u{0634}', '\u{0635}', '\u{0636}', '\u{00D7}',
    '\u{0637}', '\u{0638}', '\u{0639}', '\u{063A}', '\u{0640}', '\u{0641}', '\u{0642}', '\u{0643}',
    '\u{00E0}', '\u{0644}', '\u{00E2}', '\u{0645}', '\u{0646}', '\u{0647}', '\u{0648}', '\u{00E7}',
    '\u{00E8}', '\u{00E9}', '\u{00EA}', '\u{00EB}', '\u{0649}', '\u{064A}', '\u{00EE}', '\u{00EF}',
    '\u{064B}', '\u{064C}', '\u{064D}', '\u{064E}', '\u{00F4}', '\u{064F}', '\u{0650}', '\u{00F7}',
    '\u{0651}', '\u{00F9}', '\u{0652}', '\u{00FB}', '\u{00FC}', '\u{200E}', '\u{200F}', '\u{06D2}',
];

fn decode_cp1256(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| if b < 0x80 { b as char } else { CP1256_HIGH[(b - 0x80) as usize] })
        .collect()
}

/// latin-1: every byte IS its codepoint. Cannot fail, which is why it is the last resort.
fn decode_latin1(bytes: &[u8]) -> String {
    bytes.iter().map(|&b| b as char).collect()
}

fn decode_utf16(bytes: &[u8], little: bool) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| if little { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) })
        .collect();
    String::from_utf16_lossy(&units)
}

/// Read the `encoding="…"` of an XML declaration, looking only at the ASCII-safe head.
///
/// Reads the head as latin-1 on purpose: the declaration is ASCII in EVERY encoding this handles,
/// so it is legible before we know the encoding — which is the whole point of an XML declaration.
fn declared_encoding(bytes: &[u8]) -> Option<Encoding> {
    let head = decode_latin1(&bytes[..bytes.len().min(256)]).to_ascii_lowercase();
    let start = head.find("encoding")?;
    let rest = &head[start + "encoding".len()..];
    let rest = rest.trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let quote = rest.chars().next()?;
    if quote != '"' && quote != '\'' {
        return None;
    }
    let value = &rest[1..];
    let end = value.find(quote)?;
    Some(match value[..end].trim() {
        "utf-8" | "utf8" | "us-ascii" | "ascii" => Encoding::Utf8,
        "utf-16" | "utf16" | "utf-16le" => Encoding::Utf16Le,
        "utf-16be" => Encoding::Utf16Be,
        "windows-1256" | "cp1256" | "iso-8859-6" | "arabic" => Encoding::Windows1256,
        "windows-1252" | "cp1252" | "iso-8859-1" | "latin1" | "latin-1" => Encoding::Latin1,
        _ => return None,
    })
}

/// Decode an OPF / container / NCX document. NEVER fails.
///
/// Replaces `String::from_utf8`/`read_to_string`, which returned `Err` on any non-UTF-8 byte. That
/// error path was silently catastrophic: `parse_epub` returned `None`, so the book lost its title,
/// author, language, cover AND — because the spine could not be read — its RTL detection, importing
/// an Arabic book as `dir='ltr'`.
pub fn decode_xml(bytes: &[u8]) -> Decoded {
    // 1. A BOM is the strongest possible signal — it beats a declaration that contradicts it.
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Decoded { text: decode_utf16(&bytes[2..], true), encoding: Encoding::Utf16Le, source: EncodingSource::Bom };
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Decoded { text: decode_utf16(&bytes[2..], false), encoding: Encoding::Utf16Be, source: EncodingSource::Bom };
    }
    let body = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) { &bytes[3..] } else { bytes };
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(s) = std::str::from_utf8(body) {
            return Decoded { text: s.to_string(), encoding: Encoding::Utf8, source: EncodingSource::Bom };
        }
    }

    let declared = declared_encoding(body);

    // 2. A UTF-16 DECLARATION is honoured even against apparently-valid UTF-8. A UTF-16 document is
    //    essentially never valid UTF-8 (it is half NUL bytes), so there is no real conflict to lose.
    if let Some(enc) = declared {
        if enc == Encoding::Utf16Le || enc == Encoding::Utf16Be {
            return Decoded {
                text: decode_utf16(body, enc == Encoding::Utf16Le),
                encoding: enc,
                source: EncodingSource::Declared,
            };
        }
    }

    // 3. VALID UTF-8 BEATS ANY SINGLE-BYTE DECLARATION. Real files declare `windows-1256` and then
    //    contain UTF-8 far more often than Arabic cp1256 text coincidentally forms valid UTF-8
    //    sequences — cp1256 Arabic is dense in 0xC0–0xF2, which is not valid UTF-8 on its own.
    if let Ok(s) = std::str::from_utf8(body) {
        return Decoded {
            text: s.to_string(),
            encoding: Encoding::Utf8,
            source: if declared == Some(Encoding::Utf8) { EncodingSource::Declared } else { EncodingSource::Utf8Valid },
        };
    }

    // 4. Not valid UTF-8 — decode by the declaration when we have one we support.
    match declared {
        Some(Encoding::Windows1256) => {
            Decoded { text: decode_cp1256(body), encoding: Encoding::Windows1256, source: EncodingSource::Declared }
        }
        Some(Encoding::Latin1) => {
            Decoded { text: decode_latin1(body), encoding: Encoding::Latin1, source: EncodingSource::Declared }
        }
        // 5. Last resort. latin-1 never fails and preserves the ASCII structure, which is what the
        //    spine / cover / href parsing actually needs — so a book in an unsupported legacy
        //    encoding still gets its direction, its cover and a filename title, instead of nothing.
        _ => Decoded { text: decode_latin1(body), encoding: Encoding::Latin1, source: EncodingSource::Fallback },
    }
}

/// Strip a leading U+FEFF.
///
/// Rust's `str::trim` does NOT remove it — U+FEFF has `White_Space=No`, verified by compiling the
/// check. That is why `mimetype.trim() != "application/epub+zip"` REJECTED an otherwise valid EPUB
/// whose `mimetype` entry carried a UTF-8 BOM: a book foliate opens happily, refused at the door.
pub fn strip_bom(s: &str) -> &str {
    s.strip_prefix('\u{feff}').unwrap_or(s)
}

/// Is this `mimetype` entry acceptable? BOM-tolerant, whitespace-tolerant, case-insensitive.
pub fn mimetype_ok(raw: &str) -> bool {
    strip_bom(raw).trim().eq_ignore_ascii_case("application/epub+zip")
}

// ---------------------------------------------------------------------------
// 2B — producer detection
// ---------------------------------------------------------------------------

/// Who produced this file, when it says so.
///
/// THIS IS WHAT MAKES EVERY OTHER RULE SAFE. `<dc:title>Unknown</dc:title>` is a confident
/// placeholder *when Calibre wrote the file* and might be somebody's actual title otherwise.
/// Producer-conditioned rules are the difference between a compatibility layer and a heuristic that
/// damages good books.
pub fn detect_producer(opf: &str) -> Option<String> {
    // EPUB 2/3: <dc:contributor opf:role="bkp">calibre (9.9.0) [https://calibre-ebook.com]</dc:contributor>
    if let Some(v) = tag_with_attr(opf, "contributor", "role", "bkp") {
        let v = v.trim();
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    // Calibre also stamps <meta name="calibre:timestamp" …> even when the contributor is absent.
    if opf.contains("calibre:timestamp") || opf.contains("calibre.kovidgoyal.net") {
        return Some("calibre".to_string());
    }
    None
}

/// A coarse family for the producer string, so rules can key off a stable value.
pub fn producer_family(producer: Option<&str>) -> &'static str {
    match producer.map(|p| p.to_ascii_lowercase()) {
        Some(p) if p.contains("calibre") => "calibre",
        Some(p) if p.contains("sigil") => "sigil",
        Some(p) if p.contains("pages") => "pages",
        Some(p) if p.contains("word") || p.contains("microsoft") => "word",
        Some(_) => "other",
        None => "unknown",
    }
}

// ---------------------------------------------------------------------------
// 2C — the placeholder-aware metadata ladder
// ---------------------------------------------------------------------------

/// Values a conversion tool writes when the source document said nothing.
///
/// Compared case-insensitively against the TRIMMED whole value — never as a substring. A book
/// legitimately titled "The Unknown Soldier" must not be mistaken for a placeholder, and that is
/// exactly the kind of damage a careless rule would do.
const TITLE_PLACEHOLDERS: &[&str] = &[
    "unknown", "untitled", "unknown book", "untitled book", "no title", "notitle", "default",
    "document", "document1", "doc1", "new document", "book", "epub", "calibre", "unnamed",
    "غير معروف", "بدون عنوان", "بلا عنوان", "مستند", "كتاب",
];

const AUTHOR_PLACEHOLDERS: &[&str] = &[
    "unknown", "unknown author", "anonymous", "author", "unknown_author", "user", "admin",
    "calibre", "word", "microsoft word", "none", "n/a", "na", "default",
    "غير معروف", "مجهول", "بدون مؤلف", "مؤلف",
];

fn is_placeholder(value: &str, list: &[&str], identifier: Option<&str>) -> bool {
    let v = strip_bom(value).trim();
    if v.is_empty() {
        return true;
    }
    let lower = v.to_lowercase();
    if list.iter().any(|p| *p == lower) {
        return true;
    }
    // A title that is literally the book's own identifier is a placeholder too — a `urn:uuid:…`
    // is not something a reader recognises as a book.
    if let Some(id) = identifier {
        let id = id.trim();
        if !id.is_empty() && v.eq_ignore_ascii_case(id) {
            return true;
        }
    }
    // A bare UUID / URN, however it got there.
    if lower.starts_with("urn:") || is_bare_uuid(&lower) {
        return true;
    }
    false
}

fn is_bare_uuid(s: &str) -> bool {
    let t = s.trim();
    t.len() == 36
        && t.chars().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) { c == '-' } else { c.is_ascii_hexdigit() }
        })
}

pub fn is_placeholder_title(value: &str, identifier: Option<&str>) -> bool {
    is_placeholder(value, TITLE_PLACEHOLDERS, identifier)
}

pub fn is_placeholder_author(value: &str) -> bool {
    is_placeholder(value, AUTHOR_PLACEHOLDERS, None)
}

/// Where a stored value came from. Recorded per field so the metadata editor can present a guess AS
/// a guess, and so a user's correction is never confused with something Sard invented.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provenance {
    /// The file said so, and it was believable.
    Declared,
    /// Derived from the book's content (a heading, a script sniff).
    Inferred,
    /// Taken from the filename.
    Filename,
    /// Nothing usable existed; this is Sard's honest last resort.
    Default,
}

impl Provenance {
    pub fn as_str(self) -> &'static str {
        match self {
            Provenance::Declared => "declared",
            Provenance::Inferred => "inferred",
            Provenance::Filename => "filename",
            Provenance::Default => "default",
        }
    }
}

/// Serialise the per-field provenance map as a small JSON object (a settings-style blob, no schema).
pub fn provenance_json(map: &BTreeMap<&'static str, Provenance>) -> String {
    let body = map
        .iter()
        .map(|(k, v)| format!("\"{k}\":\"{}\"", v.as_str()))
        .collect::<Vec<_>>()
        .join(",");
    format!("{{{body}}}")
}

/// The title ladder. Each rung must clear BOTH "not empty" and "not a placeholder".
///
/// Rung 4 is deliberately `None` rather than a literal string: the caller supplies the localised
/// "Untitled Book", because a database should not hold a UI string in one language.
pub fn resolve_title(
    declared: Option<&str>,
    content_heading: Option<&str>,
    filename_stem: &str,
    identifier: Option<&str>,
) -> (Option<String>, Provenance) {
    if let Some(t) = declared {
        if !is_placeholder_title(t, identifier) {
            return (Some(strip_bom(t).trim().to_string()), Provenance::Declared);
        }
    }
    if let Some(h) = content_heading {
        if !is_placeholder_title(h, identifier) {
            return (Some(strip_bom(h).trim().to_string()), Provenance::Inferred);
        }
    }
    let stem = filename_stem.trim();
    if !stem.is_empty() && !is_placeholder_title(stem, identifier) {
        return (Some(stem.to_string()), Provenance::Filename);
    }
    (None, Provenance::Default)
}

/// The author ladder — two rungs and then NOTHING.
///
/// Returning `None` rather than the literal string "Unknown" is the point. The old fallback wrote
/// `author = 'Unknown'` into the row, which made "the FILE said Unknown" indistinguishable from
/// "Sard gave up" — and both states exist in the real corpus. A NULL is honest, and the UI is free
/// to render "Unknown author" as chrome.
pub fn resolve_author(declared: Option<&str>) -> (Option<String>, Provenance) {
    if let Some(a) = declared {
        if !is_placeholder_author(a) {
            return (Some(strip_bom(a).trim().to_string()), Provenance::Declared);
        }
    }
    (None, Provenance::Default)
}

// ---------------------------------------------------------------------------
// 2E — structural flags
// ---------------------------------------------------------------------------

/// Fewer than a tenth of the sections are reachable from the TOC (floor of 3 entries).
///
/// MEASURED against the real corpus. The reported book: 116 spine items, 1 NCX entry → flagged.
/// Its sibling `لورد الغوامض`: 1433 sections, 1432 entries → NOT flagged, which is the important
/// half — a finely split spine with a sound TOC is perfectly readable and must not be "recovered".
pub const TOC_MIN_RATIO_PCT: usize = 10;
pub const TOC_MIN_ENTRIES: usize = 3;

pub fn toc_degenerate(toc_entries: usize, spine_count: usize) -> bool {
    if spine_count <= TOC_MIN_ENTRIES {
        return false; // too small for the ratio to mean anything
    }
    let floor = TOC_MIN_ENTRIES.max(spine_count * TOC_MIN_RATIO_PCT / 100);
    toc_entries < floor
}

/// Many sections, each far too small to be a chapter.
///
/// MEASURED: the reported book is 115 content sections with a 2,450-byte median — Calibre split one
/// `index.html` at its own size threshold, so the breaks correspond to nothing a reader can see. In
/// paged mode `expand()` pads every section up to a whole page (paginator.js:381), so each becomes a
/// mostly-blank page.
pub const SPINE_FRAGMENT_MIN_SECTIONS: usize = 60;
pub const SPINE_FRAGMENT_MEDIAN_BYTES: u64 = 4096;

pub fn spine_fragmented(section_sizes: &[u64]) -> bool {
    if section_sizes.len() < SPINE_FRAGMENT_MIN_SECTIONS {
        return false;
    }
    let mut v = section_sizes.to_vec();
    v.sort_unstable();
    let median = v[v.len() / 2];
    median < SPINE_FRAGMENT_MEDIAN_BYTES
}

// ---------------------------------------------------------------------------
// small shared XML helpers (regex-free, allocation-light)
// ---------------------------------------------------------------------------

/// The text of the first `<…name …attr="value"…>text</…name>`, namespace-prefix agnostic.
fn tag_with_attr(xml: &str, name: &str, attr: &str, value: &str) -> Option<String> {
    let mut rest = xml;
    loop {
        let open = rest.find('<')?;
        rest = &rest[open + 1..];
        let close = rest.find('>')?;
        let tag = &rest[..close];
        let local = tag
            .split(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .next()
            .unwrap_or("")
            .rsplit(':')
            .next()
            .unwrap_or("");
        if local.eq_ignore_ascii_case(name) && attr_value(tag, attr).is_some_and(|v| v.eq_ignore_ascii_case(value)) {
            let body = &rest[close + 1..];
            let end = body.find("</")?;
            return Some(body[..end].to_string());
        }
        rest = &rest[close..];
    }
}

/// The value of `attr` inside one already-isolated tag body.
pub fn attr_value(tag: &str, attr: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut from = 0usize;
    while let Some(i) = lower[from..].find(attr) {
        let at = from + i;
        // must be preceded by whitespace so `role` does not match `opf:role` spuriously… actually
        // the reverse: require the char before to be whitespace OR a namespace colon.
        let ok_before = at == 0 || {
            let c = lower[..at].chars().next_back().unwrap_or(' ');
            c.is_whitespace() || c == ':'
        };
        let after = &lower[at + attr.len()..];
        let trimmed = after.trim_start();
        if ok_before && trimmed.starts_with('=') {
            let rest = &tag[tag.len() - trimmed.len()..];
            let rest = rest.strip_prefix('=')?.trim_start();
            let quote = rest.chars().next()?;
            if quote == '"' || quote == '\'' {
                let v = &rest[1..];
                let end = v.find(quote)?;
                return Some(v[..end].to_string());
            }
        }
        from = at + attr.len();
    }
    None
}

/// Count `<navPoint` elements in an NCX, or `<li>` inside the `<nav epub:type="toc">` of a nav doc.
pub fn count_toc_entries(nav_or_ncx: &str, is_ncx: bool) -> usize {
    if is_ncx {
        return count_occurrences(nav_or_ncx, "<navPoint");
    }
    // Scope to the toc nav: a nav document may also carry page-list and landmarks navs, whose <li>s
    // are not chapters. Counting them all inflated a corpus book's TOC from 135 to 270.
    let lower = nav_or_ncx.to_ascii_lowercase();
    let mut search_from = 0usize;
    while let Some(i) = lower[search_from..].find("<nav") {
        let start = search_from + i;
        let head_end = match lower[start..].find('>') {
            Some(j) => start + j,
            None => break,
        };
        let head = &nav_or_ncx[start..head_end];
        let is_toc = attr_value(head, "type").is_some_and(|v| v.split_whitespace().any(|t| t == "toc"));
        let body_end = lower[head_end..].find("</nav").map(|j| head_end + j).unwrap_or(lower.len());
        if is_toc {
            return count_occurrences(&nav_or_ncx[head_end..body_end], "<li");
        }
        search_from = body_end.max(start + 4);
    }
    0
}

fn count_occurrences(haystack: &str, needle: &str) -> usize {
    let mut n = 0;
    let mut rest = haystack;
    while let Some(i) = rest.find(needle) {
        n += 1;
        rest = &rest[i + needle.len()..];
    }
    n
}

/// The first `<h1>`…`<h6>` text in a content document, tags stripped, whitespace collapsed.
/// Used as rung 2 of the title ladder — the book's own first heading.
pub fn first_heading(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    for level in 1..=6u8 {
        let open = format!("<h{level}");
        let close = format!("</h{level}");
        let mut from = 0usize;
        while let Some(i) = lower[from..].find(&open) {
            let start = from + i;
            let Some(gt) = lower[start..].find('>') else { break };
            let body_start = start + gt + 1;
            let Some(j) = lower[body_start..].find(&close) else { break };
            let text = strip_tags(&html[body_start..body_start + j]);
            if !text.is_empty() {
                return Some(text);
            }
            from = body_start + j;
        }
    }
    None
}

fn strip_tags(s: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests;

/// The windows-1256 character for a high byte (`0x80 + i`). Exposed for the test encoder, which
/// builds its table by SEARCHING this one — so a typo breaks both directions and is caught, rather
/// than cancelling out between a matched pair of wrong tables.
#[cfg(test)]
pub fn cp1256_char(i: u8) -> char {
    CP1256_HIGH[i as usize]
}
