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
    // INSERT OR REPLACE so an "Edit" re-save with the same id overwrites the row (RAWY-57).
    conn.execute(
        "INSERT OR REPLACE INTO photo_cards \
         (id, book_id, book_title, author, chapter_label, cfi, format, theme_id, quote, passages, quote_font, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
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
            meta.created_at,
        ],
    )
    .map_err(|e| e.to_string())?;
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
        created_at: meta.created_at,
    })
}

/// All saved cards, newest first, each with its stored-image path.
pub fn list(conn: &Connection, app_data_dir: &Path) -> Result<Vec<PhotoCard>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, book_id, book_title, author, chapter_label, cfi, format, theme_id, quote, passages, quote_font, created_at \
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
                created_at: r.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

/// Remove the row and its stored PNG.
pub fn delete(conn: &Connection, app_data_dir: &Path, id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM photo_cards WHERE id = ?1", [id])
        .map_err(|e| e.to_string())?;
    let path = app_data_dir.join("photocards").join(format!("{id}.png"));
    let _ = fs::remove_file(path); // best-effort; a missing file is fine
    Ok(())
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
        migrations::run(&conn).unwrap();
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
}
