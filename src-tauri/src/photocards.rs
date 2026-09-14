//! Saved photo cards (RAWY-52, Photo Mode part 2a). "Save in app" writes the rendered PNG to
//! `app_data/photocards/<id>.png` and a `photo_cards` row; the gallery lists them newest-first
//! and loads each thumbnail from `image_path` via the asset protocol (like book covers).

use std::fs;
use std::path::Path;

use rusqlite::Connection;
use serde::Serialize;

#[derive(Serialize)]
pub struct PhotoCard {
    pub id: String,
    pub book_id: Option<String>,
    pub book_title: Option<String>,
    pub author: Option<String>,
    pub chapter_label: Option<String>,
    pub cfi: Option<String>,
    pub format: Option<String>,
    pub theme_id: Option<String>,
    pub quote: Option<String>,
    /// JSON array of { text, chapterLabel } when the card collects >1 passage (RAWY-60); NULL for
    /// a single-passage card (which uses `quote`). Lets "Edit" restore the full collection.
    pub passages: Option<String>,
    /// RAWY-81 (#1): the quote's own font key (built-in family key or imported family name); NULL =
    /// follow the book's script font. Lets "Edit" restore the chosen quote font.
    pub quote_font: Option<String>,
    /// The card's COMPOSITION document (frontend-owned JSON). NULL for a card saved before the
    /// document existed — the UI reconstructs that card's composition from the columns above, which
    /// reproduces exactly what it used to do, so an old card opens unchanged.
    pub doc: Option<String>,
    pub created_at: i64,
    /// Absolute path to the stored PNG (served to the UI via the asset protocol).
    pub image_path: String,
}

#[allow(clippy::too_many_arguments)]
pub struct SaveMeta {
    pub id: String,
    pub book_id: Option<String>,
    pub book_title: Option<String>,
    pub author: Option<String>,
    pub chapter_label: Option<String>,
    pub cfi: Option<String>,
    pub format: Option<String>,
    pub theme_id: Option<String>,
    pub quote: Option<String>,
    pub passages: Option<String>,
    pub quote_font: Option<String>,
    pub doc: Option<String>,
    /// Every managed background id this card's composition uses — its ground and its stickers.
    ///
    /// Passed in ALONGSIDE `doc` rather than parsed out of it, because the collector must be able to
    /// learn what a card references without reading frontend-owned JSON. These become rows in
    /// `photo_card_images`, written in the same transaction as the card itself.
    pub images: Vec<String>,
    pub created_at: i64,
}

fn image_path(app_data_dir: &Path, id: &str) -> String {
    app_data_dir
        .join("photocards")
        .join(format!("{id}.png"))
        .to_string_lossy()
        .into_owned()
}

/// Write the PNG bytes + insert the row; return the saved card (with its image path).
pub fn save(
    conn: &Connection,
    app_data_dir: &Path,
    meta: SaveMeta,
    data: &[u8],
) -> Result<PhotoCard, String> {
    let dir = app_data_dir.join("photocards");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(format!("{}.png", meta.id));
    fs::write(&path, data).map_err(|e| e.to_string())?;
    // THE ROW AND ITS IMAGE BINDINGS ARE ONE WRITE.
    //
    // `backgrounds::gc()` deletes every managed image no reference source names, and it runs inside
    // `set_surface()` — so a window in which the card row exists but its bindings do not is a window
    // in which changing the wallpaper deletes that card's images. The same indivisibility the
    // backgrounds module demands of its own bind path is demanded here.
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // INSERT OR REPLACE so an "Edit" re-save with the same id overwrites the row (RAWY-57).
    tx.execute(
        "INSERT OR REPLACE INTO photo_cards \
         (id, book_id, book_title, author, chapter_label, cfi, format, theme_id, quote, passages, quote_font, doc, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        rusqlite::params![
            meta.id,
            meta.book_id,
            meta.book_title,
            meta.author,
            meta.chapter_label,
            meta.cfi,
            meta.format,
            meta.theme_id,
            meta.quote,
            meta.passages,
            meta.quote_font,
            meta.doc,
            meta.created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
    // Rewritten wholesale rather than diffed: an edit that REMOVES a sticker must drop that binding,
    // and recomputing the set is the same self-healing argument `gc()` itself makes about refcounts.
    tx.execute("DELETE FROM photo_card_images WHERE card_id = ?1", [&meta.id])
        .map_err(|e| e.to_string())?;
    for bg in &meta.images {
        if bg.is_empty() {
            continue;
        }
        tx.execute(
            "INSERT OR IGNORE INTO photo_card_images (card_id, background_id) VALUES (?1, ?2)",
            rusqlite::params![meta.id, bg],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(PhotoCard {
        image_path: image_path(app_data_dir, &meta.id),
        id: meta.id,
        book_id: meta.book_id,
        book_title: meta.book_title,
        author: meta.author,
        chapter_label: meta.chapter_label,
        cfi: meta.cfi,
        format: meta.format,
        theme_id: meta.theme_id,
        quote: meta.quote,
        passages: meta.passages,
        quote_font: meta.quote_font,
        doc: meta.doc,
        created_at: meta.created_at,
    })
}

/// All saved cards, newest first, each with its stored-image path.
pub fn list(conn: &Connection, app_data_dir: &Path) -> Result<Vec<PhotoCard>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, book_id, book_title, author, chapter_label, cfi, format, theme_id, quote, passages, quote_font, doc, created_at \
             FROM photo_cards ORDER BY created_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            Ok(PhotoCard {
                image_path: image_path(app_data_dir, &id),
                id,
                book_id: r.get(1)?,
                book_title: r.get(2)?,
                author: r.get(3)?,
                chapter_label: r.get(4)?,
                cfi: r.get(5)?,
                format: r.get(6)?,
                theme_id: r.get(7)?,
                quote: r.get(8)?,
                passages: r.get(9)?,
                quote_font: r.get(10)?,
                doc: r.get(11)?,
                created_at: r.get(12)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Remove the row and its stored PNG.
pub fn delete(conn: &Connection, app_data_dir: &Path, id: &str) -> Result<(), String> {
    // Bindings go explicitly rather than by cascade: `PRAGMA foreign_keys` is not guaranteed on for
    // this connection, and a binding left behind keeps an image alive that nothing uses any more.
    conn.execute("DELETE FROM photo_card_images WHERE card_id = ?1", [id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM photo_cards WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    let path = app_data_dir.join("photocards").join(format!("{id}.png"));
    let _ = fs::remove_file(path); // best-effort; a missing file is fine
    Ok(())
}

/// IMPORT AN IMAGE AND BIND IT TO A CARD THAT IS STILL BEING COMPOSED — as one operation.
///
/// `backgrounds::import` alone leaves the new row UNREFERENCED, and `gc()` collects anything no
/// source names. It runs inside `set_surface()`, so the window between "the user picked a sticker"
/// and "the user pressed Save" is a window in which changing the wallpaper deletes that sticker. The
/// backgrounds module already paid for this exact bug once with its own two-step bind.
///
/// So the binding is written in the SAME transaction as the import, against the id the card WILL be
/// saved under. From the moment the file is copied, a reference source names it. A composer that is
/// closed without saving leaves a binding for a card that does not exist — a leak, not a loss — and
/// `sweep_draft_bindings` reclaims those at startup, where it cannot race a live composer.
pub fn stage_image(
    conn: &Connection,
    app_data_dir: &Path,
    card_id: &str,
    src_path: &str,
) -> Result<crate::backgrounds::Background, String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let row = crate::backgrounds::import(&tx, app_data_dir, src_path)?;
    tx.execute(
        "INSERT OR IGNORE INTO photo_card_images (card_id, background_id) VALUES (?1, ?2)",
        rusqlite::params![card_id, row.id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(row)
}

/// Drop bindings that name a card which was never saved.
///
/// Called ONCE at startup, deliberately: during a session those bindings are exactly what protects a
/// composer's imported images, so collecting them then would reintroduce the very window `stage_image`
/// closes. Between runs there is no composer to protect, so anything unclaimed is genuinely rubbish.
pub fn sweep_draft_bindings(conn: &Connection) -> Result<usize, String> {
    conn.execute(
        "DELETE FROM photo_card_images WHERE card_id NOT IN (SELECT id FROM photo_cards)",
        [],
    )
    .map_err(|e| e.to_string())
}

/// THE FIFTH REFERENCE SOURCE for `backgrounds::gc()` — every image any saved card uses.
///
/// Reads the binding TABLE, never the `doc` column, so the collector answers this question without
/// parsing frontend-owned JSON. Wired into `gc()` in the same change as the write path above, which
/// is the rule the backgrounds module states about anything that becomes a new source.
pub fn referenced_backgrounds(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT DISTINCT background_id FROM photo_card_images")?;
    let ids = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<String>>>()?;
    Ok(ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::migrations;

    // RAWY-81 (#1): a card's quote font survives save → list (so "Edit" restores it), and a null
    // font (the book-font default) round-trips too.
    #[test]
    fn quote_font_round_trips() {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn, None).unwrap();
        let tmp = std::env::temp_dir().join("sard_rawy81_cards");
        let _ = fs::remove_dir_all(&tmp);

        let meta = |id: &str, qf: Option<&str>, at: i64| SaveMeta {
            id: id.into(),
            book_id: None,
            book_title: Some("Book".into()),
            author: None,
            chapter_label: None,
            cfi: None,
            format: Some("portrait".into()),
            theme_id: Some("ivory".into()),
            quote: Some("hello".into()),
            passages: None,
            quote_font: qf.map(|s| s.to_string()),
            doc: None,
            images: Vec::new(),
            created_at: at,
        };

        let saved = save(&conn, &tmp, meta("card1", Some("arefRuqaa"), 100), b"png").unwrap();
        assert_eq!(saved.quote_font.as_deref(), Some("arefRuqaa"));
        save(&conn, &tmp, meta("card2", None, 200), b"png").unwrap(); // default (book font)

        let listed = list(&conn, &tmp).unwrap();
        let c1 = listed.iter().find(|c| c.id == "card1").unwrap();
        let c2 = listed.iter().find(|c| c.id == "card2").unwrap();
        assert_eq!(c1.quote_font.as_deref(), Some("arefRuqaa"), "chosen font must survive save→list");
        assert!(c2.quote_font.is_none(), "null (book-font) must round-trip as null");

        let _ = fs::remove_dir_all(&tmp);
    }

    fn meta_for(id: &str, doc: Option<&str>, images: &[&str]) -> SaveMeta {
        SaveMeta {
            id: id.into(),
            book_id: None,
            book_title: Some("Book".into()),
            author: None,
            chapter_label: None,
            cfi: None,
            format: Some("portrait".into()),
            theme_id: Some("ivory".into()),
            quote: Some("hello".into()),
            passages: None,
            quote_font: None,
            doc: doc.map(|s| s.to_string()),
            images: images.iter().map(|s| (*s).to_string()).collect(),
            created_at: 100,
        }
    }

    // THE ROUND TRIP THE DOCUMENT EXISTS FOR. Before it, a card's style, text size and toggles were
    // never stored, so reopening one rebuilt it as a Minimal auto-fit card and re-saving overwrote
    // the good PNG. The document is the thing that has to survive save → list for that to be fixed.
    #[test]
    fn the_composition_document_round_trips() {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn, None).unwrap();
        let tmp = std::env::temp_dir().join("sard_card_doc");
        let _ = fs::remove_dir_all(&tmp);

        let doc = r#"{"v":1,"preset":{"style":"gilded","textSize":"xl"}}"#;
        let saved = save(&conn, &tmp, meta_for("c1", Some(doc), &[]), b"png").unwrap();
        assert_eq!(saved.doc.as_deref(), Some(doc));

        let listed = list(&conn, &tmp).unwrap();
        let c1 = listed.iter().find(|c| c.id == "c1").unwrap();
        assert_eq!(c1.doc.as_deref(), Some(doc), "the document must survive save then list");

        let _ = fs::remove_dir_all(&tmp);
    }

    // A card written before the document existed reads back as NULL, which is what tells the UI to
    // reconstruct its composition from the legacy columns instead of inventing one.
    #[test]
    fn a_card_without_a_document_reads_back_null() {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn, None).unwrap();
        let tmp = std::env::temp_dir().join("sard_card_nodoc");
        let _ = fs::remove_dir_all(&tmp);

        save(&conn, &tmp, meta_for("legacy", None, &[]), b"png").unwrap();
        let listed = list(&conn, &tmp).unwrap();
        assert!(listed.iter().find(|c| c.id == "legacy").unwrap().doc.is_none());

        let _ = fs::remove_dir_all(&tmp);
    }

    // The bindings are what the collector reads. They must appear on save, follow an edit that adds
    // or removes an image, and disappear with the card — or an image is either lost or leaked.
    #[test]
    fn image_bindings_track_the_card() {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn, None).unwrap();
        let tmp = std::env::temp_dir().join("sard_card_imgs");
        let _ = fs::remove_dir_all(&tmp);

        save(&conn, &tmp, meta_for("c1", Some("{}"), &["bg-1", "st-1"]), b"png").unwrap();
        let mut got = referenced_backgrounds(&conn).unwrap();
        got.sort();
        assert_eq!(got, vec!["bg-1".to_string(), "st-1".to_string()]);

        // An edit that drops the sticker and adds another must leave exactly the new set.
        save(&conn, &tmp, meta_for("c1", Some("{}"), &["bg-1", "st-2"]), b"png").unwrap();
        let mut after = referenced_backgrounds(&conn).unwrap();
        after.sort();
        assert_eq!(after, vec!["bg-1".to_string(), "st-2".to_string()], "a removed sticker must unbind");

        // A second card sharing an image, then deleting the first: the image is still referenced.
        save(&conn, &tmp, meta_for("c2", Some("{}"), &["bg-1"]), b"png").unwrap();
        delete(&conn, &tmp, "c1").unwrap();
        let left = referenced_backgrounds(&conn).unwrap();
        assert!(left.contains(&"bg-1".to_string()), "the surviving card still holds it");
        assert!(!left.contains(&"st-2".to_string()), "the deleted card's own sticker unbinds");

        delete(&conn, &tmp, "c2").unwrap();
        assert!(referenced_backgrounds(&conn).unwrap().is_empty(), "no card, no reference");

        let _ = fs::remove_dir_all(&tmp);
    }

    // An empty id must never become a binding row — it would name nothing and confuse the collector.
    #[test]
    fn an_empty_image_id_is_not_bound() {
        let conn = Connection::open_in_memory().unwrap();
        migrations::run(&conn, None).unwrap();
        let tmp = std::env::temp_dir().join("sard_card_empty");
        let _ = fs::remove_dir_all(&tmp);
        save(&conn, &tmp, meta_for("c1", Some("{}"), &["", "ok"]), b"png").unwrap();
        assert_eq!(referenced_backgrounds(&conn).unwrap(), vec!["ok".to_string()]);
        let _ = fs::remove_dir_all(&tmp);
    }
}
