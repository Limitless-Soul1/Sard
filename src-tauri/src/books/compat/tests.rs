//! RESILIENCE-1 / WP-2 — tests for the compatibility layer.
//!
//! The contract, in order of importance:
//!   1. A GOOD book is never altered. A compatibility layer that damages well-authored files is
//!      worse than none, so every rule is tested for what it must NOT do as well as what it does.
//!   2. The measured corpus values are pinned — the thresholds were derived from real books, and a
//!      later edit that breaks them should fail loudly.
//!   3. Nothing panics on any input.

use super::*;

// ---------------------------------------------------------------------------
// 2A — decoding
// ---------------------------------------------------------------------------

#[test]
fn decodes_plain_utf8() {
    let d = decode_xml("<?xml version=\"1.0\" encoding=\"UTF-8\"?><t>مرحبا</t>".as_bytes());
    assert_eq!(d.encoding, Encoding::Utf8);
    assert!(d.text.contains("مرحبا"));
}

#[test]
fn strips_a_utf8_bom() {
    let mut bytes = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice("<t>ok</t>".as_bytes());
    let d = decode_xml(&bytes);
    assert_eq!(d.source, EncodingSource::Bom);
    assert!(d.text.starts_with("<t>"), "the BOM must not survive into the parsed text: {:?}", d.text);
}

#[test]
fn decodes_utf16_by_bom_in_both_endiannesses() {
    let text = "<t>مرحبا</t>";
    let mut le = vec![0xFF, 0xFE];
    for u in text.encode_utf16() {
        le.extend_from_slice(&u.to_le_bytes());
    }
    let d = decode_xml(&le);
    assert_eq!(d.encoding, Encoding::Utf16Le);
    assert!(d.text.contains("مرحبا"));

    let mut be = vec![0xFE, 0xFF];
    for u in text.encode_utf16() {
        be.extend_from_slice(&u.to_be_bytes());
    }
    let d = decode_xml(&be);
    assert_eq!(d.encoding, Encoding::Utf16Be);
    assert!(d.text.contains("مرحبا"));
}

#[test]
fn decodes_a_declared_windows_1256_opf() {
    // THE defect: `read_to_string` returned Err on these bytes, so `parse_epub` returned None and
    // the book lost title, author, language, cover AND its RTL detection in one go.
    let mut bytes = b"<?xml version='1.0' encoding='windows-1256'?><dc:title>".to_vec();
    bytes.extend_from_slice(&[0xE3, 0xD1, 0xCD, 0xC8, 0xC7]); // مرحبا in cp1256
    bytes.extend_from_slice(b"</dc:title>");
    let d = decode_xml(&bytes);
    assert_eq!(d.encoding, Encoding::Windows1256);
    assert_eq!(d.source, EncodingSource::Declared);
    assert!(d.text.contains("مرحبا"), "decoded: {:?}", d.text);
}

#[test]
fn cp1256_round_trips_the_arabic_alphabet() {
    // A table typo would silently corrupt every Arabic title from a legacy file, so check the
    // contiguous alphabet block rather than a sample.
    let bytes: Vec<u8> = (0xC7u8..=0xD6).collect(); // ا … ض
    let s = decode_cp1256(&bytes);
    assert_eq!(s.chars().next(), Some('\u{0627}')); // ا
    assert!(s.chars().all(|c| ('\u{0621}'..='\u{064A}').contains(&c)), "unexpected: {s:?}");
}

#[test]
fn invalid_utf8_falls_back_instead_of_failing() {
    let bytes = vec![0x3C, 0x74, 0x3E, 0xFF, 0xFE_u8.wrapping_add(1), 0x3C, 0x2F, 0x74, 0x3E];
    let d = decode_xml(&bytes);
    assert_eq!(d.source, EncodingSource::Fallback);
    assert!(d.text.starts_with("<t>"), "ASCII structure must survive: {:?}", d.text);
}

#[test]
fn a_stale_declaration_does_not_mangle_valid_utf8() {
    // Real files declare windows-1256 and then contain UTF-8. Trust the bytes: valid UTF-8 that
    // decodes as Arabic is overwhelmingly more likely to BE UTF-8 than to be a cp1256 coincidence.
    let src = "<?xml version='1.0' encoding='windows-1256'?><dc:title>مرحبا</dc:title>";
    let d = decode_xml(src.as_bytes());
    assert_eq!(d.encoding, Encoding::Utf8);
    assert!(d.text.contains("مرحبا"));
}

#[test]
fn decode_never_panics_on_anything() {
    for bytes in [
        vec![],
        vec![0x00],
        vec![0xFF],
        vec![0xFF, 0xFE],
        vec![0xEF, 0xBB],
        vec![0xEF, 0xBB, 0xBF],
        (0u8..=255).collect::<Vec<_>>(),
        b"<?xml encoding=".to_vec(),
        b"<?xml encoding=\"".to_vec(),
        b"<?xml encoding=\"unknown-thing\"?>x".to_vec(),
    ] {
        let _ = decode_xml(&bytes);
    }
}

// ---------------------------------------------------------------------------
// mimetype tolerance
// ---------------------------------------------------------------------------

#[test]
fn mimetype_accepts_a_bom_which_used_to_be_rejected() {
    // Verified by compiling the check: '\u{feff}'.is_whitespace() is FALSE, so `trim()` leaves the
    // BOM and the old equality test refused a valid book.
    assert!(!'\u{feff}'.is_whitespace(), "the premise of this fix");
    assert!(mimetype_ok("\u{feff}application/epub+zip"));
}

#[test]
fn mimetype_still_accepts_what_it_always_did() {
    // Backward compatibility: every form that worked before MUST keep working.
    assert!(mimetype_ok("application/epub+zip"));
    assert!(mimetype_ok("application/epub+zip\n"));
    assert!(mimetype_ok("  application/epub+zip  "));
    assert!(mimetype_ok("APPLICATION/EPUB+ZIP"));
}

#[test]
fn mimetype_still_rejects_what_is_not_an_epub() {
    assert!(!mimetype_ok("application/zip"));
    assert!(!mimetype_ok(""));
    assert!(!mimetype_ok("application/epub"));
    assert!(!mimetype_ok("text/plain"));
}

// ---------------------------------------------------------------------------
// 2B — producer
// ---------------------------------------------------------------------------

#[test]
fn detects_calibre_from_the_contributor_the_reported_book_carries() {
    let opf = r#"<metadata><dc:contributor opf:role="bkp">calibre (9.9.0) [https://calibre-ebook.com]</dc:contributor></metadata>"#;
    let p = detect_producer(opf).expect("producer");
    assert!(p.contains("calibre (9.9.0)"), "{p}");
    assert_eq!(producer_family(Some(&p)), "calibre");
}

#[test]
fn detects_calibre_from_its_timestamp_meta_alone() {
    let opf = r#"<metadata><meta name="calibre:timestamp" content="2026-08-04T13:43:25"/></metadata>"#;
    assert_eq!(producer_family(detect_producer(opf).as_deref()), "calibre");
}

#[test]
fn a_book_with_no_producer_statement_reports_none() {
    let opf = r#"<metadata><dc:title>A Book</dc:title><dc:creator>An Author</dc:creator></metadata>"#;
    assert_eq!(detect_producer(opf), None);
    assert_eq!(producer_family(None), "unknown");
}

#[test]
fn contributor_without_the_bkp_role_is_not_a_producer() {
    // `<dc:contributor opf:role="edt">` is an editor — a person, not a tool.
    let opf = r#"<metadata><dc:contributor opf:role="edt">A Human Editor</dc:contributor></metadata>"#;
    assert_eq!(detect_producer(opf), None);
}

// ---------------------------------------------------------------------------
// 2C — the metadata ladder
// ---------------------------------------------------------------------------

#[test]
fn recognises_the_reported_books_placeholders() {
    assert!(is_placeholder_title("Unknown", None));
    assert!(is_placeholder_author("word"));
}

#[test]
fn placeholders_are_matched_whole_never_as_substrings() {
    // THE damage a careless rule would do. Every one of these is a real title or author.
    for good in ["The Unknown Soldier", "Unknown Pleasures", "Book of the Dead", "Documenting Chaos", "Untitled #4 (a memoir)"] {
        assert!(!is_placeholder_title(good, None), "{good} must NOT be treated as a placeholder");
    }
    for good in ["Wordsworth", "Author Unknownsson", "Anonymous Sources Ltd"] {
        assert!(!is_placeholder_author(good), "{good} must NOT be treated as a placeholder");
    }
}

#[test]
fn placeholder_matching_is_case_and_whitespace_insensitive() {
    for v in ["unknown", "UNKNOWN", "  Unknown  ", "Untitled"] {
        assert!(is_placeholder_title(v, None), "{v:?}");
    }
}

#[test]
fn recognises_arabic_placeholders() {
    assert!(is_placeholder_title("غير معروف", None));
    assert!(is_placeholder_title("بدون عنوان", None));
    assert!(!is_placeholder_title("الأمير الصغير", None));
}

#[test]
fn a_title_that_is_the_identifier_or_a_bare_uuid_is_a_placeholder() {
    let id = "urn:uuid:d35c722d-41d3-4c42-ada1-bb5d5ad338bb";
    assert!(is_placeholder_title(id, Some(id)));
    assert!(is_placeholder_title("urn:uuid:d35c722d-41d3-4c42-ada1-bb5d5ad338bb", None));
    assert!(is_placeholder_title("d35c722d-41d3-4c42-ada1-bb5d5ad338bb", None));
    assert!(!is_placeholder_title("d35c722d", None), "a short hex word is not a UUID");
}

#[test]
fn title_ladder_prefers_a_real_declared_title_and_says_so() {
    let (t, p) = resolve_title(Some("الأمير الصغير"), Some("Chapter 1"), "file-stem", None);
    assert_eq!(t.as_deref(), Some("الأمير الصغير"));
    assert_eq!(p, Provenance::Declared);
}

#[test]
fn title_ladder_falls_through_a_placeholder_to_the_content_heading() {
    let (t, p) = resolve_title(Some("Unknown"), Some("مقدمة ابن خلدون"), "a4", None);
    assert_eq!(t.as_deref(), Some("مقدمة ابن خلدون"));
    assert_eq!(p, Provenance::Inferred);
}

#[test]
fn title_ladder_reaches_the_filename_when_the_heading_is_also_a_placeholder() {
    // The reported book exactly: dc:title "Unknown" AND <title>Unknown</title> in every section.
    let (t, p) = resolve_title(Some("Unknown"), Some("Unknown"), "لورد الغوامض", None);
    assert_eq!(t.as_deref(), Some("لورد الغوامض"));
    assert_eq!(p, Provenance::Filename);
}

#[test]
fn title_ladder_ends_at_none_never_at_the_string_unknown() {
    let (t, p) = resolve_title(Some("Unknown"), None, "untitled", None);
    assert_eq!(t, None, "the last rung is None — the caller supplies a LOCALISED default");
    assert_eq!(p, Provenance::Default);
}

#[test]
fn author_ladder_returns_none_rather_than_the_literal_unknown() {
    // The old fallback wrote 'Unknown' into the row, making "the file said Unknown" and "Sard gave
    // up" indistinguishable — and BOTH states exist in the real corpus.
    let (a, p) = resolve_author(Some("word"));
    assert_eq!(a, None);
    assert_eq!(p, Provenance::Default);

    let (a, p) = resolve_author(Some("أحمد شوقي"));
    assert_eq!(a.as_deref(), Some("أحمد شوقي"));
    assert_eq!(p, Provenance::Declared);
}

#[test]
fn provenance_serialises_as_a_small_json_object() {
    let mut m = BTreeMap::new();
    m.insert("title", Provenance::Filename);
    m.insert("author", Provenance::Default);
    assert_eq!(provenance_json(&m), r#"{"author":"default","title":"filename"}"#);
}

// ---------------------------------------------------------------------------
// 2E — structural flags (thresholds pinned to real measurements)
// ---------------------------------------------------------------------------

#[test]
fn toc_degenerate_flags_the_reported_book_and_spares_its_sibling() {
    assert!(toc_degenerate(1, 116), "the reported book: 116 sections, 1 NCX entry");
    assert!(toc_degenerate(1, 196), "the second Word conversion: 196 sections, 1 entry");
    // THE IMPORTANT HALF — a finely split spine with a sound TOC is perfectly readable.
    assert!(!toc_degenerate(1432, 1433), "لورد الغوامض must NOT be flagged");
    assert!(!toc_degenerate(1166, 1166), "حلقة الحتمية must NOT be flagged");
    assert!(!toc_degenerate(112, 113), "الداء والدواء must NOT be flagged");
    assert!(!toc_degenerate(122, 122), "The Count of Monte Cristo must NOT be flagged");
}

#[test]
fn toc_degenerate_does_not_fire_on_a_small_book() {
    // 4 sections with 3 TOC entries is a normal short book, not a defect.
    assert!(!toc_degenerate(3, 4), "رسالة الغفران");
    assert!(!toc_degenerate(0, 1));
    assert!(!toc_degenerate(0, 3));
}

#[test]
fn spine_fragmented_matches_the_measured_shape() {
    // The reported book: 115 sections, 2450-byte median.
    let reported: Vec<u64> = (0..115).map(|i| if i % 2 == 0 { 2_450 } else { 2_500 }).collect();
    assert!(spine_fragmented(&reported));

    // A large book with real chapters is NOT fragmented, however many sections it has.
    let big_chapters: Vec<u64> = (0..1433).map(|_| 20_000).collect();
    assert!(!spine_fragmented(&big_chapters), "لورد الغوامض has many sections but they are real");

    // Few sections never counts, whatever their size.
    assert!(!spine_fragmented(&[100; 10]));
    assert!(!spine_fragmented(&[]));
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

#[test]
fn counts_ncx_navpoints() {
    let ncx = "<ncx><navMap><navPoint id='a'><navLabel><text>A</text></navLabel></navPoint>\
                <navPoint id='b'/></navMap></ncx>";
    assert_eq!(count_toc_entries(ncx, true), 2);
}

#[test]
fn counts_only_the_toc_nav_not_page_list_or_landmarks() {
    // A corpus book's nav doc carries all three; counting every <li> inflated its TOC from 135 to
    // 270, which would have mis-measured a perfectly good book.
    let nav = r#"<html><body>
        <nav epub:type="toc"><ol><li>1</li><li>2</li><li>3</li></ol></nav>
        <nav epub:type="page-list"><ol><li>p1</li><li>p2</li><li>p3</li><li>p4</li></ol></nav>
        <nav epub:type="landmarks"><ol><li>x</li></ol></nav>
      </body></html>"#;
    assert_eq!(count_toc_entries(nav, false), 3);
}

#[test]
fn a_nav_document_with_no_toc_nav_counts_zero() {
    let nav = r#"<html><body><nav epub:type="landmarks"><ol><li>x</li></ol></nav></body></html>"#;
    assert_eq!(count_toc_entries(nav, false), 0);
}

#[test]
fn finds_the_first_real_heading_for_the_title_ladder() {
    let html = "<html><head><title>Unknown</title></head><body><h1>  مقدمة  <span>ابن خلدون</span></h1><p>x</p></body></html>";
    assert_eq!(first_heading(html).as_deref(), Some("مقدمة ابن خلدون"));
}

#[test]
fn skips_an_empty_heading_and_tries_the_next_level() {
    let html = "<html><body><h1>   </h1><h2>Real Heading</h2></body></html>";
    assert_eq!(first_heading(html).as_deref(), Some("Real Heading"));
}

#[test]
fn returns_none_when_a_document_has_no_heading() {
    assert_eq!(first_heading("<html><body><p>just prose</p></body></html>"), None);
}

#[test]
fn attr_value_reads_namespaced_attributes() {
    assert_eq!(attr_value(r#"item opf:role="bkp""#, "role").as_deref(), Some("bkp"));
    assert_eq!(attr_value(r#"item role='bkp'"#, "role").as_deref(), Some("bkp"));
    assert_eq!(attr_value(r#"item properties="nav""#, "properties").as_deref(), Some("nav"));
    assert_eq!(attr_value("item id=x", "id"), None, "unquoted values are not valid XML");
}

#[test]
fn helpers_never_panic_on_malformed_markup() {
    for junk in ["", "<", "<<>>", "<nav", "<nav>", "</nav>", "<h1>", "<h1></h2>", "<a b='"] {
        let _ = count_toc_entries(junk, false);
        let _ = count_toc_entries(junk, true);
        let _ = first_heading(junk);
        let _ = detect_producer(junk);
        let _ = attr_value(junk, "id");
    }
}
